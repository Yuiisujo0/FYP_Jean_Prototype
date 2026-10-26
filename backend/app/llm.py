"""Talks to a local Ollama server and turns a request into a validated workflow.

Pipeline:  retrieve patterns -> prompt -> model (schema-constrained JSON) -> validate -> repair loop.
The model never executes anything; it only drafts steps from the known catalogue.
"""
import json
import time
from dataclasses import dataclass, field

import httpx
from pydantic import ValidationError

from . import config
from .errors import ModelOutputError, OllamaError
from .graph import chain_edges, default_position, make_id
from .knowledge import KnowledgeEntry
from .naming import step_description, step_name
from .node_kinds import BY_TYPE, catalogue_text
from .retrieval import retrieve
from .schema import DraftWorkflow, Flow, Step, ValidationIssue, draft_json_schema
from .validate import error_count, validate_workflow


@dataclass
class Attempt:
    errors: int
    warnings: int
    ms: int
    eval_tokens: int = 0
    prompt_tokens: int = 0
    load_ms: int = 0
    prompt_ms: int = 0
    gen_ms: int = 0
    neurons: float = 0.0   # Cloudflare only: cost against the free daily allowance
    note: str = ""


@dataclass
class GenerationResult:
    flow: Flow
    issues: list[ValidationIssue]
    retrieved: list[KnowledgeEntry]
    attempts: list[Attempt] = field(default_factory=list)
    elapsed_ms: int = 0
    model: str = ""

    @property
    def valid(self) -> bool:
        return error_count(self.issues) == 0


# ---------- Ollama HTTP ----------

async def list_models() -> list[str]:
    if config.PROVIDER == "cloudflare":
        from . import cloudflare
        problem = cloudflare.credentials_missing()
        if problem:
            raise OllamaError(problem)
        return [config.CF_MODEL]
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(f"{config.OLLAMA_URL}/api/tags")
            res.raise_for_status()
    except httpx.HTTPError as e:
        raise OllamaError(f"Cannot reach Ollama at {config.OLLAMA_URL}. Is it running? ({type(e).__name__})") from e
    return [m["name"] for m in res.json().get("models", [])]


# Models that reject the `think` flag (anything that is not a reasoning model), learned on first use.
_NO_THINK_FLAG: set[str] = set()


async def chat_json(model: str, messages: list[dict], schema: dict, temperature: float = 0.1, num_ctx: int | None = None) -> tuple[str, dict]:
    """One non-streaming chat call whose output is constrained to `schema`. Returns (content, stats)."""
    if config.PROVIDER == "cloudflare":
        from . import cloudflare
        return await cloudflare.chat_json(model, messages, schema, temperature)
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "format": schema,
        "keep_alive": "10m",
        "options": {"temperature": temperature, "num_ctx": num_ctx or config.NUM_CTX},
    }
    if model not in _NO_THINK_FLAG:
        payload["think"] = False  # reasoning models burn seconds "thinking"; structured output does not need it
    try:
        async with httpx.AsyncClient(timeout=config.OLLAMA_TIMEOUT) as client:
            res = await client.post(f"{config.OLLAMA_URL}/api/chat", json=payload)
            if res.status_code == 400 and "think" in res.text.lower() and "think" in payload:
                _NO_THINK_FLAG.add(model)
                payload.pop("think")
                res = await client.post(f"{config.OLLAMA_URL}/api/chat", json=payload)
    except httpx.TimeoutException as e:
        raise OllamaError(f"The model took longer than {config.OLLAMA_TIMEOUT:.0f}s to answer.") from e
    except httpx.HTTPError as e:
        raise OllamaError(f"Cannot reach Ollama at {config.OLLAMA_URL}. ({type(e).__name__})") from e

    if res.status_code == 404:
        raise OllamaError(f"Model '{model}' is not installed. Run: ollama pull {model}")
    if res.status_code >= 400:
        raise OllamaError(f"Ollama returned {res.status_code}: {res.text[:300]}")

    body = res.json()
    ms = lambda key: int(body.get(key, 0) / 1e6)  # noqa: E731  (Ollama reports nanoseconds)
    return body["message"]["content"], {
        "eval_count": body.get("eval_count", 0),
        "prompt_tokens": body.get("prompt_eval_count", 0),
        "load_ms": ms("load_duration"),
        "prompt_ms": ms("prompt_eval_duration"),
        "gen_ms": ms("eval_duration"),
    }


async def gpu_share(model: str) -> float | None:
    """Fraction of the loaded model that sits in VRAM (1.0 = fully on the GPU). None if it is not loaded."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(f"{config.OLLAMA_URL}/api/ps")
        for m in res.json().get("models", []):
            if m["name"] == model or m["model"] == model:
                return round(m.get("size_vram", 0) / m["size"], 2) if m.get("size") else None
    except (httpx.HTTPError, ValueError, KeyError):
        pass
    return None


# ---------- Prompting ----------

MAX_DATASETS_IN_PROMPT = 6
MAX_COLUMNS_IN_PROMPT = 12


MAX_CATEGORY_VALUES = 8     # a column with at most this many distinct values is listed in full
MAX_EXAMPLE_VALUES = 3      # any other column gets this many examples
MAX_VALUE_CHARS = 24


def sample_values(columns: list[str], rows: list[dict]) -> dict[str, dict]:
    """A few values per column, for a LOCAL model only. {column: {"values": [...], "all": True if the list is every distinct value}}."""
    out: dict[str, dict] = {}
    for c in columns:
        seen: list[str] = []
        for r in rows:
            v = str(r.get(c, "")).strip()[:MAX_VALUE_CHARS]
            if v and v not in seen:
                seen.append(v)
                if len(seen) > MAX_CATEGORY_VALUES:
                    break
        complete = len(seen) <= MAX_CATEGORY_VALUES
        out[c] = {"values": seen if complete else seen[:MAX_EXAMPLE_VALUES], "all": complete}
    return out


def _values_allowed() -> bool:
    return config.SHOW_VALUES and config.PROVIDER == "ollama"


def datasets_text(datasets: list[dict]) -> str:
    """The user's uploaded datasets: names and columns. Rows are never sent, except that a local model may be shown a few
    example values per column when SHOW_VALUES is on (the data does not leave the machine)."""
    if not datasets:
        return ""
    lines = []
    with_values = False
    for d in datasets[:MAX_DATASETS_IN_PROMPT]:
        cols = d["columns"][:MAX_COLUMNS_IN_PROMPT]
        more = ", ..." if len(d["columns"]) > len(cols) else ""
        samples = d.get("samples") if _values_allowed() else None
        if samples:
            with_values = True
            parts = []
            for c in cols:
                s = samples.get(c)
                if s and s["values"]:
                    parts.append(f"{c} ({'' if s['all'] else 'e.g. '}{', '.join(s['values'])})")
                else:
                    parts.append(c)
            lines.append(f"- {d['name']}: columns {'; '.join(parts)}{more}")
        else:
            lines.append(f"- {d['name']}: columns {', '.join(cols)}{more}")
    text = (
        "\n\nThe user has uploaded these datasets:\n" + "\n".join(lines)
        + "\nIf the request is about this data, set READ_CSV file to the dataset's exact name and use only its column names in conditions."
    )
    if with_values:
        text += "\nValues in brackets show what each column holds. Use them to pick the right column, and copy a value exactly as written."
    return text


def system_prompt(retrieved: list[KnowledgeEntry], datasets: list[dict] | None = None) -> str:
    patterns = "\n".join(f"- {e.title}: {e.detail}" for e in retrieved) or "- (none)"
    return f"""You convert a user's request into a linear automation workflow.

Use ONLY these operations:
{catalogue_text()}

Answer with JSON: {{"steps": [...]}}. Each step is one flat object. Its "type" is an operation name and its other
fields are that operation's parameters.

Rules:
- The workflow is linear: each step feeds the next one.
- The first step must be a data source (INPUT, READ_FILE, READ_CSV or HTTP_REQUEST).
- The last step must be OUTPUT.
- Fill every parameter with a concrete value taken from the request, for example a FILTER condition such as "score < 50".
- Use only as many steps as the request needs, between 2 and 6. Do not add steps the user did not ask for.

Relevant reference patterns:
{patterns}{datasets_text(datasets or [])}"""


def repair_message(issues: list[ValidationIssue]) -> str:
    problems = "\n".join(f"- {i.message}" for i in issues if i.level == "ERROR")
    return f"That workflow has problems:\n{problems}\nReturn a corrected, complete workflow."


EXAMPLE_REQUEST = "Pull weather data from an API and show just the temperature and city"

# Keep this example out of eval/prompts.json, or the evaluation measures memorisation instead of generalisation.
EXAMPLE_ANSWER = json.dumps({"steps": [
    {"type": "HTTP_REQUEST", "method": "GET", "url": "https://api.example.com/weather"},
    {"type": "TRANSFORM", "operation": "select temperature, city"},
    {"type": "OUTPUT", "format": "table"},
]}, separators=(",", ":"))


# ---------- Draft -> Flow ----------

def normalize_config(type_: str, raw_config: dict[str, str]) -> dict[str, str]:
    """A step's parameters tidied the way every workflow is: trimmed, optional ones defaulted, empty ones dropped."""
    config = {k: v.strip() for k, v in raw_config.items()}
    kind = BY_TYPE.get(type_)
    if kind:
        # Optional parameters the model left blank get the operation's default (e.g. delimiter ",").
        for key in kind.optional:
            if not config.get(key):
                config[key] = kind.default_config.get(key, "")
        # Blank *required* values are kept on purpose: the validator reports them and triggers a repair.
        config = {k: v for k, v in config.items() if v or k in kind.required}
    return config


def build_flow(draft: DraftWorkflow, prompt: str) -> Flow:
    """Turn the model's bare steps into a full Flow: names, descriptions, ids, edges and positions are ours.

    A workflow with no OUTPUT step gets one at the end. Models often stop at the last real action ("... then save them to
    the database"); asking them to repair that costs a whole extra call, and they tend to do it by REPLACING the last step
    with OUTPUT, which silently drops what the user asked for.
    """
    raws = list(draft.steps)
    if raws and all(r.get("type") != "OUTPUT" for r in raws):
        raws.append({"type": "OUTPUT", "format": "table"})
    steps = []
    for i, raw in enumerate(raws):
        type_ = raw.get("type", "")
        config = normalize_config(type_, {k: v for k, v in raw.items() if k != "type"})
        steps.append(Step(
            id=make_id(),
            type=type_,
            name=step_name(type_, config) if type_ in BY_TYPE else type_ or "Unknown step",
            description=step_description(type_),
            config=config,
            position=default_position(i),
        ))
    title = prompt if len(prompt) <= 42 else prompt[:42].rstrip() + "\u2026"
    return Flow(
        id=make_id(),
        name=title[:1].upper() + title[1:],
        description=prompt,
        updatedAt=int(time.time() * 1000),
        nodes=steps,
        edges=chain_edges(steps),
    )


# ---------- The pipeline ----------

def timing(stats: dict) -> dict:
    return {"eval_tokens": stats["eval_count"], "prompt_tokens": stats["prompt_tokens"], "load_ms": stats["load_ms"], "prompt_ms": stats["prompt_ms"], "gen_ms": stats["gen_ms"], "neurons": stats.get("neurons", 0.0)}

TEMPERATURES = (0.1, 0.5, 0.8)


async def _converse(model: str, messages: list[dict], title: str) -> tuple[Flow, list[ValidationIssue], list[Attempt]]:
    """Ask the model for steps, validate them, and send any errors back for repair. Shared by generating and refining."""
    schema = draft_json_schema()
    attempts: list[Attempt] = []
    best: tuple[Flow, list[ValidationIssue]] | None = None

    for attempt_no in range(config.MAX_REPAIRS + 1):
        t0 = time.perf_counter()
        # Retries run hotter: at a low temperature the model just repeats the same mistake.
        try:
            content, stats = await chat_json(model, messages, schema, temperature=TEMPERATURES[min(attempt_no, len(TEMPERATURES) - 1)])
        except ModelOutputError as e:   # the provider could not meet the schema: try again, hotter
            attempts.append(Attempt(errors=1, warnings=0, ms=int((time.perf_counter() - t0) * 1000), note=f"output rejected by provider: {e}"[:160]))
            continue
        ms = int((time.perf_counter() - t0) * 1000)

        try:
            draft = DraftWorkflow.model_validate(json.loads(content))
        except (json.JSONDecodeError, ValidationError) as e:
            attempts.append(Attempt(errors=1, warnings=0, ms=ms, note=f"unparseable: {type(e).__name__}", **timing(stats)))
            messages += [{"role": "assistant", "content": content}, {"role": "user", "content": "That was not valid JSON for the schema. Return the workflow again."}]
            continue

        flow = build_flow(draft, title)
        issues = validate_workflow(flow.nodes, flow.edges)
        attempts.append(Attempt(errors=error_count(issues), warnings=len(issues) - error_count(issues), ms=ms, **timing(stats)))
        best = (flow, issues)
        if error_count(issues) == 0:
            break
        messages += [{"role": "assistant", "content": content}, {"role": "user", "content": repair_message(issues)}]

    if best is None:
        err = OllamaError("The model did not return a usable workflow after several attempts.")
        err.attempts = attempts  # type: ignore[attr-defined]  # so callers can still account for what the failed attempts cost
        raise err
    return best[0], best[1], attempts


async def generate_workflow(prompt: str, model: str | None = None, datasets: list[dict] | None = None, retrieval: str | None = None) -> GenerationResult:
    model = model or config.default_model()
    started = time.perf_counter()
    retrieved = retrieve(prompt, mode=retrieval)
    messages: list[dict] = [
        {"role": "system", "content": system_prompt(retrieved, datasets)},
        {"role": "user", "content": EXAMPLE_REQUEST},
        {"role": "assistant", "content": EXAMPLE_ANSWER},
        {"role": "user", "content": prompt},
    ]
    flow, issues, attempts = await _converse(model, messages, prompt)
    return GenerationResult(
        flow=flow, issues=issues, retrieved=retrieved, attempts=attempts,
        elapsed_ms=int((time.perf_counter() - started) * 1000), model=model,
    )


# ---------- Refining an existing workflow ----------

def refine_system_prompt(datasets: list[dict] | None = None) -> str:
    return f"""You edit a linear automation workflow.

Use ONLY these operations:
{catalogue_text()}

You are given the current workflow as JSON and an instruction. Answer with the complete updated workflow as JSON:
{{"steps": [...]}}. Each step is one flat object. Its "type" is an operation name and its other fields are that
operation's parameters.

Rules:
- Change only what the instruction asks for. Keep every other step exactly as it is, in the same order.
- The workflow stays linear: each step feeds the next one.
- The first step must be a data source (INPUT, READ_FILE, READ_CSV or HTTP_REQUEST).
- The last step must be OUTPUT.
- Use between 2 and 7 steps in total.
- If the instruction cannot be done with these operations, return the current workflow unchanged.{datasets_text(datasets or [])}"""


def flat_steps_json(steps: list[dict]) -> str:
    """The workflow as the model writes it: one flat object per step, `type` first."""
    return json.dumps({"steps": [{"type": st["type"], **st.get("config", {})} for st in steps]}, separators=(",", ":"), ensure_ascii=False)


def refine_messages(steps: list[dict], instruction: str, datasets: list[dict] | None = None) -> list[dict]:
    return [
        {"role": "system", "content": refine_system_prompt(datasets)},
        {"role": "user", "content": f"Current workflow:\n{flat_steps_json(steps)}\n\nInstruction: {instruction}"},
    ]


@dataclass
class RefineResult:
    nodes: list[Step]
    issues: list[ValidationIssue]
    attempts: list[Attempt]
    elapsed_ms: int
    model: str
    unchanged: bool   # the model returned the workflow as it was

    @property
    def valid(self) -> bool:
        return error_count(self.issues) == 0


async def _edit(steps: list[dict], messages: list[dict], title: str, model: str | None) -> RefineResult:
    """Ask for a whole new version of `steps` and report whether it differs. Shared by refining and revising."""
    model = model or config.default_model()
    started = time.perf_counter()
    flow, issues, attempts = await _converse(model, messages, title)
    before = [(st["type"], normalize_config(st["type"], st.get("config", {}))) for st in steps]
    after = [(n.type, n.config) for n in flow.nodes]
    return RefineResult(
        nodes=flow.nodes, issues=issues, attempts=attempts, elapsed_ms=int((time.perf_counter() - started) * 1000),
        model=model, unchanged=before == after,
    )


async def refine_workflow(steps: list[dict], instruction: str, model: str | None = None, datasets: list[dict] | None = None) -> RefineResult:
    """Change `steps` (each {"type", "config"}) as `instruction` says. The model sees the workflow and the instruction, never any data."""
    return await _edit(steps, refine_messages(steps, instruction, datasets), instruction, model)


# ---------- Revising after a test run (the agent's observe-and-revise step) ----------

def revise_system_prompt(datasets: list[dict] | None = None) -> str:
    return f"""You check a linear automation workflow against what happened when it was run.

Use ONLY these operations:
{catalogue_text()}

You are given the user's request, the current workflow as JSON, and a report of what happened when the workflow ran
on the user's data (counts and column names only). Answer with the complete workflow as JSON: {{"steps": [...]}}.
Each step is one flat object. Its "type" is an operation name and its other fields are that operation's parameters.

Rules:
- If the report shows the workflow does not do what the request asks (an error, an empty result, a step that did not
  run, a filter that kept every row), correct the workflow.
- Lines that start with "Check:" point at a likely mistake in how the request became steps (a value the request names
  that no filter uses, a value in the wrong column, a value the request never mentions, a ranking with no sort, and/or
  without brackets). Fix each one so the workflow does exactly what the request says.
- If the report is what the request should give, return the workflow unchanged.
- Change as little as possible, and do not add steps the request does not ask for.
- The workflow stays linear: each step feeds the next one.
- The first step must be a data source (INPUT, READ_FILE, READ_CSV or HTTP_REQUEST).
- The last step must be OUTPUT.
- Use between 2 and 7 steps in total.{datasets_text(datasets or [])}"""


def revise_messages(request: str, steps: list[dict], observation: str, datasets: list[dict] | None = None) -> list[dict]:
    return [
        {"role": "system", "content": revise_system_prompt(datasets)},
        {"role": "user", "content": f"Request: {request}\n\nCurrent workflow:\n{flat_steps_json(steps)}\n\nWhat happened when it ran:\n{observation}"},
    ]


async def revise_workflow(request: str, steps: list[dict], observation: str, model: str | None = None, datasets: list[dict] | None = None) -> RefineResult:
    """Revise `steps` given what a test run showed. The observation holds counts and column names, never data values
    (the browser builds it; see src/lib/observe.ts)."""
    return await _edit(steps, revise_messages(request, steps, observation, datasets), request, model)

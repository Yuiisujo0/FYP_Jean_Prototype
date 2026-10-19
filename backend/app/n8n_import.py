"""Converts a third-party n8n workflow (JSON) into this project's linear, 9-operation workflow pattern.

The input is untrusted data: it is only ever parsed with `json`, never executed. Anything that cannot be expressed
in the 9 operations is REJECTED with a reason (branching, merging, code nodes, unknown node types), not approximated
silently. Each accepted pattern records whether the mapping was exact or approximate.
"""
import hashlib
import re
from dataclasses import dataclass, field

from .node_kinds import BY_TYPE

# ---- node type -> (operation, exact?) ------------------------------------------------------------------------------
# Keys are the lower-cased last part of the n8n node type, e.g. "n8n-nodes-base.httpRequest" -> "httprequest".
MAP: dict[str, tuple[str, bool]] = {
    "httprequest": ("HTTP_REQUEST", True),
    "spreadsheetfile": ("READ_CSV", True), "extractfromfile": ("READ_CSV", False),
    "readbinaryfile": ("READ_FILE", True), "readbinaryfiles": ("READ_FILE", True), "readwritefile": ("READ_FILE", False),
    "filter": ("FILTER", True),
    **{k: ("TRANSFORM", True) for k in ("set", "itemlists", "sort", "limit", "removeduplicates", "aggregate", "splitout", "summarize", "renamekeys")},
    **{k: ("TRANSFORM", False) for k in ("datetime", "html", "xml", "crypto", "markdown", "compression", "converttofile")},
    **{k: ("DATABASE", True) for k in ("postgres", "mysql", "microsoftsql", "mongodb", "supabase", "questdb", "timescaledb", "cratedb", "snowflake")},
    **{k: ("DATABASE", False) for k in ("googlesheets", "airtable", "nocodb", "baserow", "notion", "seatable", "grist")},
    **{k: ("LLM", True) for k in ("openai", "anthropic", "googlegemini", "ollama", "mistralai", "huggingface", "agent", "chainllm",
                                  "chainsummarization", "informationextractor", "textclassifier", "sentimentanalysis")},
    **{k: ("OUTPUT", True) for k in ("respondtowebhook", "emailsend", "slack", "telegram", "discord", "writebinaryfile")},
    **{k: ("OUTPUT", False) for k in ("gmail", "microsoftteams", "whatsapp", "twilio", "mattermost", "pushover", "matrix", "sendgrid", "mailgun")},
}
PASS_THROUGH = {"stickynote", "noop", "wait", "stopanderror"}            # no effect on the data
CODE_NODES = {"code", "function", "functionitem", "executecommand", "python"}  # arbitrary code: excluded by project scope
BRANCHING = {"if", "switch", "merge", "splitinbatches", "loopoverbatches", "compareDatasets".lower()}
LC_ATTACHMENT = re.compile(r"^(lm|embeddings|memory|tool|outputparser|vectorstore|retriever|textsplitter|document|reranker)", re.I)
TRIGGER = re.compile(r"(trigger$|^cron$|^webhook$|^start$|^interval$)", re.I)

OPERATORS = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<=", "equals": "==", "notequals": "!=", "contains": "contains"}


@dataclass
class Result:
    ok: bool
    reason: str = ""                      # why it was rejected
    detail: list[str] = field(default_factory=list)  # e.g. the unmapped node types
    pattern: dict | None = None


def _short(node_type: str) -> str:
    return node_type.rsplit(".", 1)[-1].lower()


def _is_langchain(node_type: str) -> bool:
    return node_type.startswith("@n8n/n8n-nodes-langchain")


def _expr_free(value: object) -> str:
    """A parameter value if it is a plain string, '' if it is an n8n expression (={{ ... }})."""
    if not isinstance(value, str):
        return ""
    v = value.strip()
    return "" if (v.startswith("=") or "{{" in v) else v


def _config(op: str, node: dict, short: str) -> dict[str, str]:
    p = node.get("parameters") or {}
    name = (node.get("name") or "").strip()
    kind = BY_TYPE[op]
    cfg = dict(kind.default_config)
    if op == "HTTP_REQUEST":
        url = _expr_free(p.get("url"))
        cfg["url"] = url if url.startswith("http") else "https://api.example.com/data"
        cfg["method"] = (_expr_free(p.get("method")) or _expr_free(p.get("requestMethod")) or "GET").upper()
    elif op == "FILTER":
        cond = ""
        try:
            first = p["conditions"]["conditions"][0]
            field_name = re.search(r"\$json\.(\w+)|\$json\[['\"](\w+)", str(first.get("leftValue", "")))
            operation = OPERATORS.get(str(first.get("operator", {}).get("operation", "")).lower())
            right = _expr_free(first.get("rightValue"))
            if field_name and operation and right != "":
                cond = f"{field_name.group(1) or field_name.group(2)} {operation} {right}"
        except (KeyError, IndexError, TypeError, AttributeError):
            pass
        cfg["condition"] = cond or (name.lower() if name and name.lower() != "filter" else "value > 0")
    elif op == "TRANSFORM":
        cfg["operation"] = (name or short).lower()[:60]
    elif op == "DATABASE":
        table = p.get("table")
        table = table.get("value") if isinstance(table, dict) else table
        cfg["table"] = _expr_free(table) or _expr_free(p.get("collection")) or "records"
    elif op == "LLM":
        cfg["task"] = (name or "process text").lower()[:60]
    elif op == "OUTPUT":
        cfg["format"] = ("email" if short in {"emailsend", "gmail", "sendgrid", "mailgun"}
                         else "response" if short == "respondtowebhook"
                         else "file" if short in {"writebinaryfile"} else "message")
    elif op == "READ_CSV":
        cfg["file"] = _expr_free(p.get("fileName")) or "data.csv"
    elif op == "READ_FILE":
        cfg["file"] = _expr_free(p.get("fileSelector")) or _expr_free(p.get("fileName")) or "document.txt"
    return {k: v for k, v in cfg.items() if v}


def convert(wf: object, source_path: str = "") -> Result:
    if not isinstance(wf, dict) or not isinstance(wf.get("nodes"), list) or not wf["nodes"]:
        return Result(False, "not a workflow")
    nodes = {n["name"]: n for n in wf["nodes"] if isinstance(n, dict) and isinstance(n.get("name"), str) and isinstance(n.get("type"), str)}
    if not nodes:
        return Result(False, "not a workflow")

    def is_pass(n: dict) -> bool:
        return bool(n.get("disabled")) or _short(n["type"]) in PASS_THROUGH
    def is_attachment(n: dict) -> bool:
        return _is_langchain(n["type"]) and bool(LC_ATTACHMENT.match(_short(n["type"])))

    # main-connection graph. n8n keys connections by node NAME, but some exports use the node id; accept both.
    ref = {name: name for name in nodes}
    ref.update({str(n.get("id")): name for name, n in nodes.items() if n.get("id") is not None})
    edges: dict[str, list[str]] = {}
    conns = wf.get("connections")
    for raw_src, conn in (conns.items() if isinstance(conns, dict) else []):
        src = ref.get(raw_src)
        if src is None:
            continue
        for out in (conn.get("main") if isinstance(conn, dict) else None) or []:
            for link in out or []:
                dst = ref.get(link.get("node")) if isinstance(link, dict) else None
                if dst is not None and dst not in edges.get(src, []):
                    edges.setdefault(src, []).append(dst)

    def expand(name: str, seen: frozenset = frozenset()) -> list[str]:
        """Targets of `name`, looking through pass-through nodes."""
        out: list[str] = []
        for t in edges.get(name, []):
            if t in seen:
                continue
            if is_pass(nodes[t]):
                out += expand(t, seen | {name})
            else:
                out.append(t)
        return list(dict.fromkeys(out))

    members = [n for n, node in nodes.items() if not is_pass(node) and not is_attachment(node)]
    if len(members) < 1:
        return Result(False, "empty")
    if len(members) > 1 and not any(expand(m) for m in members):
        return Result(False, "no connections")

    out = {m: [t for t in expand(m) if t in members] for m in members}
    incoming: dict[str, int] = {m: 0 for m in members}
    for m in members:
        for t in out[m]:
            incoming[t] += 1
    if any(len(v) > 1 for v in out.values()) or any(c > 1 for c in incoming.values()):
        return Result(False, "branching or merging")
    starts = [m for m in members if incoming[m] == 0]
    if len(starts) != 1:
        return Result(False, "several starts or a loop")
    chain, cur = [], starts[0]
    while cur and cur not in chain:
        chain.append(cur)
        cur = out[cur][0] if out[cur] else None
    if len(chain) != len(members):
        return Result(False, "disconnected nodes")

    # map each node
    ops: list[tuple[str, dict, bool]] = []   # (operation, config, exact)
    unmapped: list[str] = []
    for name in chain:
        node = nodes[name]
        short = _short(node["type"])
        if short in CODE_NODES:
            return Result(False, "code node", [node["type"]])
        if short in BRANCHING:
            return Result(False, "branching or merging", [node["type"]])
        if TRIGGER.search(short):
            ops.append(("INPUT", {"source": short.replace("trigger", "") or "manual"}, True))
        elif short in MAP:
            op, exact = MAP[short]
            ops.append((op, _config(op, node, short), exact))
        else:
            unmapped.append(node["type"])
    if unmapped:
        return Result(False, "unmapped node types", unmapped)

    notes: list[str] = []
    if len(ops) > 1 and ops[0][0] == "INPUT" and BY_TYPE[ops[1][0]].is_source:
        ops.pop(0)                                         # a trigger followed by a data source: the source starts the flow
    if not BY_TYPE[ops[0][0]].is_source:
        ops.insert(0, ("INPUT", {"source": "manual"}, True)); notes.append("added INPUT")
    if ops[-1][0] != "OUTPUT":
        ops.append(("OUTPUT", {"format": "table"}, True)); notes.append("added OUTPUT")
    if not 2 <= len(ops) <= 7:
        return Result(False, "length outside 2-7 steps")

    title = str(wf.get("name") or "").strip() or "Untitled workflow"
    notes_text = " ".join(
        str((n.get("parameters") or {}).get("content", "")) for n in wf["nodes"]
        if isinstance(n, dict) and _short(str(n.get("type", ""))) == "stickynote"
    )
    description = " ".join(str(wf.get("description") or "").split())[:300]
    exact = all(e for _, _, e in ops[:]) and not notes
    sequence = [op for op, _, _ in ops]
    node_names = " ".join(nodes[c]["name"] for c in chain)
    return Result(True, pattern={
        "id": hashlib.sha1(source_path.encode()).hexdigest()[:12],
        "title": title[:140],
        "description": description,
        "steps": [{"type": op, "config": cfg} for op, cfg, _ in ops],
        "opSequence": ">".join(sequence),
        "quality": "exact" if exact else "approx",
        "notes": notes,
        "sourcePath": source_path,
        "text": " ".join([title, description, " ".join(notes_text.split())[:300], node_names]),
    })

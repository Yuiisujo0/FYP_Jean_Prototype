import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import db
from ..llm import OllamaError, generate_workflow, refine_workflow, revise_workflow
from ..schema import Flow, FlowEdge, Step, ValidationIssue
from ..validate import validate_workflow

router = APIRouter(tags=["workflows"])
log = logging.getLogger("jwork.generate")


class DatasetBrief(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    columns: list[str] = Field(max_length=100)


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=500)
    model: str | None = None
    # Names and columns (never rows). When the browser sends them they are used; otherwise the backend's own data library is.
    datasets: list[DatasetBrief] | None = None


class RetrievedEntry(BaseModel):
    id: str
    title: str


class AttemptInfo(BaseModel):
    errors: int
    warnings: int
    ms: int
    evalTokens: int
    note: str


class GenerateResponse(BaseModel):
    flow: Flow
    valid: bool
    issues: list[ValidationIssue]
    retrieved: list[RetrievedEntry]
    attempts: list[AttemptInfo]
    elapsedMs: int
    model: str


@router.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest) -> GenerateResponse:
    prompt = req.prompt.strip()
    try:
        result = await generate_workflow(prompt, req.model, [d.model_dump() for d in req.datasets] if req.datasets is not None else db.list_datasets())
    except OllamaError as e:
        spent = sum(a.neurons for a in getattr(e, "attempts", []))
        log.warning("generate failed: %s | neurons spent=%.1f | prompt=%r", e, spent, prompt)
        raise HTTPException(status_code=502, detail=str(e)) from e
    log.info(
        "generate model=%s datasets=%d valid=%s attempts=%d total=%dms neurons=%.1f steps=%s | prompt=%r",
        result.model, len(db.list_datasets()), result.valid, len(result.attempts), result.elapsed_ms, sum(a.neurons for a in result.attempts),
        ">".join(n.type for n in result.flow.nodes), prompt,
    )
    for i, a in enumerate(result.attempts, 1):
        log.info("  attempt %d: %dms, %d tokens, errors=%d %s", i, a.ms, a.eval_tokens, a.errors, a.note)
    return GenerateResponse(
        flow=result.flow,
        valid=result.valid,
        issues=result.issues,
        retrieved=[RetrievedEntry(id=e.id, title=e.title) for e in result.retrieved],
        attempts=[AttemptInfo(errors=a.errors, warnings=a.warnings, ms=a.ms, evalTokens=a.eval_tokens, note=a.note) for a in result.attempts],
        elapsedMs=result.elapsed_ms,
        model=result.model,
    )


class ValidateRequest(BaseModel):
    nodes: list[Step]
    edges: list[FlowEdge]


@router.post("/validate", response_model=list[ValidationIssue])
async def validate(req: ValidateRequest) -> list[ValidationIssue]:
    """Same checks as the frontend, so the two can be compared."""
    return validate_workflow(req.nodes, req.edges)


@router.get("/patterns")
async def list_patterns() -> list[dict]:
    """The example workflows the model may be shown before it generates."""
    return db.list_patterns()


class StepIn(BaseModel):
    type: str = Field(min_length=1, max_length=40)
    config: dict[str, str] = Field(default_factory=dict)


class RefineRequest(BaseModel):
    steps: list[StepIn] = Field(min_length=1, max_length=10)
    instruction: str = Field(min_length=3, max_length=300)
    model: str | None = None
    datasets: list[DatasetBrief] | None = None


class RefineResponse(BaseModel):
    nodes: list[Step]
    valid: bool
    issues: list[ValidationIssue]
    unchanged: bool
    attempts: list[AttemptInfo]
    elapsedMs: int
    model: str


def _check_steps(steps: list[StepIn]) -> None:
    if any(len(st.config) > 10 or any(len(k) > 40 or len(v) > 300 for k, v in st.config.items()) for st in steps):
        raise HTTPException(status_code=422, detail="A step has too many or too long parameters.")


def _refine_response(result) -> RefineResponse:
    return RefineResponse(
        nodes=result.nodes, valid=result.valid, issues=result.issues, unchanged=result.unchanged,
        attempts=[AttemptInfo(errors=a.errors, warnings=a.warnings, ms=a.ms, evalTokens=a.eval_tokens, note=a.note) for a in result.attempts],
        elapsedMs=result.elapsed_ms, model=result.model,
    )


@router.post("/refine", response_model=RefineResponse)
async def refine(req: RefineRequest) -> RefineResponse:
    """Change a workflow as the instruction says. Only the steps and the instruction are used; no data is involved."""
    _check_steps(req.steps)
    instruction = req.instruction.strip()
    datasets = [d.model_dump() for d in req.datasets] if req.datasets is not None else db.list_datasets()
    try:
        result = await refine_workflow([st.model_dump() for st in req.steps], instruction, req.model, datasets)
    except OllamaError as e:
        log.warning("refine failed: %s | instruction=%r", e, instruction)
        raise HTTPException(status_code=502, detail=str(e)) from e
    log.info(
        "refine model=%s valid=%s unchanged=%s attempts=%d total=%dms neurons=%.1f steps=%s | instruction=%r",
        result.model, result.valid, result.unchanged, len(result.attempts), result.elapsed_ms,
        sum(a.neurons for a in result.attempts), ">".join(n.type for n in result.nodes), instruction,
    )
    return _refine_response(result)


class ReviseRequest(BaseModel):
    request: str = Field(min_length=3, max_length=500)
    steps: list[StepIn] = Field(min_length=1, max_length=10)
    # What a test run in the browser showed: counts and column names, never data values.
    observation: str = Field(min_length=1, max_length=2000)
    model: str | None = None
    datasets: list[DatasetBrief] | None = None


@router.post("/revise", response_model=RefineResponse)
async def revise(req: ReviseRequest) -> RefineResponse:
    """The agent's revise step: given what a test run showed, correct the workflow or return it unchanged."""
    _check_steps(req.steps)
    datasets = [d.model_dump() for d in req.datasets] if req.datasets is not None else db.list_datasets()
    try:
        result = await revise_workflow(req.request.strip(), [st.model_dump() for st in req.steps], req.observation.strip(), req.model, datasets)
    except OllamaError as e:
        log.warning("revise failed: %s | request=%r", e, req.request)
        raise HTTPException(status_code=502, detail=str(e)) from e
    log.info(
        "revise model=%s valid=%s unchanged=%s attempts=%d total=%dms neurons=%.1f steps=%s | observation=%r",
        result.model, result.valid, result.unchanged, len(result.attempts), result.elapsed_ms,
        sum(a.neurons for a in result.attempts), ">".join(n.type for n in result.nodes), req.observation[:300],
    )
    return _refine_response(result)

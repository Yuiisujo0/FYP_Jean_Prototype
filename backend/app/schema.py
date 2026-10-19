"""Workflow data models.

`Flow` is the shape the React frontend already uses (camelCase `updatedAt`).
`DraftWorkflow` is the much smaller shape the LLM is asked to produce: just step types and their parameters.
Names, descriptions, ids, edges and positions are filled in by the server, which keeps the model's output
short (fewer tokens = faster on a laptop GPU) and removes things it could get wrong.
"""
from pydantic import BaseModel, Field

from .node_kinds import NODE_KINDS


class Position(BaseModel):
    x: float
    y: float


class Step(BaseModel):
    id: str
    type: str
    name: str
    description: str = ""
    config: dict[str, str] = Field(default_factory=dict)
    position: Position | None = None


class FlowEdge(BaseModel):
    id: str
    source: str
    target: str


class Flow(BaseModel):
    id: str
    name: str
    description: str = ""
    updatedAt: int
    nodes: list[Step]
    edges: list[FlowEdge]


class ValidationIssue(BaseModel):
    level: str  # "ERROR" | "WARNING"
    message: str
    nodeId: str | None = None


# ---------- What the model is asked to return ----------

class DraftWorkflow(BaseModel):
    """`steps` are flat objects such as {"type": "FILTER", "condition": "score < 50"}."""
    steps: list[dict[str, str]]


def draft_json_schema() -> dict:
    """JSON Schema for Ollama's `format` field.

    Each step is one of nine variants, one per supported operation. A variant fixes the `type` and lists that
    operation's parameters as required string fields. So the model cannot emit an unsupported operation or
    forget a required parameter: the constrained decoder simply will not allow it.
    """
    variants = []
    for kind in NODE_KINDS:
        params = [*kind.required, *(p for p in kind.optional if p not in kind.required)]
        variants.append({
            "type": "object",
            "properties": {"type": {"type": "string", "enum": [kind.type]}, **{p: {"type": "string"} for p in params}},
            "required": ["type", *params],
        })
    return {
        "type": "object",
        "properties": {"steps": {"type": "array", "minItems": 2, "maxItems": 7, "items": {"anyOf": variants}}},
        "required": ["steps"],
    }

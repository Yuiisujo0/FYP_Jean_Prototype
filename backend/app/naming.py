"""Readable step names and descriptions, derived from the step type and its parameters.

The model is not asked to write these. They are cheap to compute, never wrong, and keeping them out of the
model's output removes roughly half of its tokens.
"""
from .node_kinds import BY_TYPE


def _short(text: str, limit: int = 38) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def step_name(type_: str, config: dict[str, str]) -> str:
    c = lambda key, fallback="": config.get(key, "").strip() or fallback  # noqa: E731
    named = {
        "INPUT": lambda: "Start",
        "READ_FILE": lambda: f"Read {c('file', 'file')}",
        "READ_CSV": lambda: f"Read {c('file', 'CSV')}",
        "LLM": lambda: f"Model: {c('task', 'process text')}",
        "FILTER": lambda: f"Filter: {c('condition', 'matching rows')}",
        "TRANSFORM": lambda: c("operation", "Transform data").capitalize(),
        "DATABASE": lambda: f"Save to {c('table', 'database')}",
        "HTTP_REQUEST": lambda: f"{c('method', 'GET').upper()} request",
        "OUTPUT": lambda: f"Output as {c('format', 'result')}",
    }
    if type_ in named:
        return _short(named[type_]())
    return BY_TYPE[type_].default_name if type_ in BY_TYPE else type_.title()


def step_description(type_: str) -> str:
    kind = BY_TYPE.get(type_)
    return kind.default_description if kind else ""

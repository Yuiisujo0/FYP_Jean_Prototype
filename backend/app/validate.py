"""Structural checks on a linear workflow. A port of src/lib/validate.ts.

The same rules judge the model's output (to trigger a repair) and the user's hand-edited flows.
"""
from .graph import order_steps
from .node_kinds import BY_TYPE
from .schema import FlowEdge, Step, ValidationIssue


def validate_workflow(steps: list[Step], edges: list[FlowEdge]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []

    def add(level: str, message: str, node_id: str | None = None) -> None:
        issues.append(ValidationIssue(level=level, message=message, nodeId=node_id))

    if not steps:
        add("ERROR", "The workflow has no operations yet.")
        return issues

    ids = {s.id for s in steps}
    label = lambda s: s.name.strip() or (BY_TYPE[s.type].label if s.type in BY_TYPE else s.type)  # noqa: E731
    ordered = order_steps(steps, edges)

    if not any(BY_TYPE[s.type].is_source for s in steps if s.type in BY_TYPE):
        add("ERROR", "Add an input or data source to start the workflow.")

    for s in steps:
        kind = BY_TYPE.get(s.type)
        if kind is None:
            add("ERROR", f"Unsupported operation: {s.type}.", s.id)
            continue
        if not s.name.strip():
            add("ERROR", f"A {kind.label} step needs a name.", s.id)
        if not s.description.strip():
            add("WARNING", f"{label(s)} could use a description.", s.id)
        for key in kind.required:
            if not s.config.get(key, "").strip():
                add("ERROR", f"{label(s)} needs a value for “{key.replace('_', ' ')}”.", s.id)

    first, last = ordered[0], ordered[-1]
    if first.type == "OUTPUT" and len(steps) > 1:
        add("ERROR", "An output cannot be the first step.", first.id)
    if last.type != "OUTPUT":
        add("ERROR", "End the workflow with an Output step.", last.id)

    incoming: dict[str, int] = {}
    outgoing: dict[str, int] = {}
    for e in edges:
        if e.source not in ids or e.target not in ids:
            add("ERROR", "A connection points to a step that no longer exists.")
            continue
        if e.source == e.target:
            add("ERROR", "A step cannot connect to itself.", e.source)
        incoming[e.target] = incoming.get(e.target, 0) + 1
        outgoing[e.source] = outgoing.get(e.source, 0) + 1

    for s in steps:
        kind = BY_TYPE.get(s.type)
        if kind is None:
            continue
        if not kind.is_source and not incoming.get(s.id):
            add("ERROR", f"{label(s)} has no input connection.", s.id)
        if len(steps) > 1 and s.type != "OUTPUT" and not outgoing.get(s.id):
            add("WARNING", f"{label(s)} is not connected to a next step.", s.id)
        if incoming.get(s.id, 0) > 1 or outgoing.get(s.id, 0) > 1:
            add("WARNING", f"{label(s)} branches. Only linear workflows are supported for now.", s.id)

    return issues


def error_count(issues: list[ValidationIssue]) -> int:
    return sum(1 for i in issues if i.level == "ERROR")

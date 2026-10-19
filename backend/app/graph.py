"""Small helpers for ordering and laying out steps. Mirrors src/lib/flowGraph.ts."""
import secrets

from .schema import FlowEdge, Position, Step

NODE_GAP_X = 264
NODE_Y = 150


def make_id() -> str:
    return secrets.token_hex(4)


def order_steps(steps: list[Step], edges: list[FlowEdge]) -> list[Step]:
    """Steps in execution order: follow edges from nodes with no incoming connection."""
    by_id = {s.id: s for s in steps}
    nxt: dict[str, str] = {}
    has_incoming: set[str] = set()
    for e in edges:
        if e.source not in by_id or e.target not in by_id:
            continue
        nxt.setdefault(e.source, e.target)
        has_incoming.add(e.target)

    seen: set[str] = set()
    out: list[Step] = []

    def walk(start: Step) -> None:
        cur: Step | None = start
        while cur and cur.id not in seen:
            seen.add(cur.id)
            out.append(cur)
            cur = by_id.get(nxt.get(cur.id, ""))

    for s in steps:
        if s.id not in has_incoming:
            walk(s)
    for s in steps:
        walk(s)
    return out


def chain_edges(steps: list[Step]) -> list[FlowEdge]:
    return [FlowEdge(id=f"e-{a.id}-{b.id}", source=a.id, target=b.id) for a, b in zip(steps, steps[1:])]


def default_position(index: int) -> Position:
    return Position(x=80 + index * NODE_GAP_X, y=NODE_Y)

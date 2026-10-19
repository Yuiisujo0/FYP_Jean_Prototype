"""The operations the system knows about. Keep in sync with src/data/nodeKinds.ts.

This catalogue is what stops the model inventing steps: it is shown to the model in the prompt,
used as an enum in the output schema, and enforced again by the validator.
"""
from dataclasses import dataclass, field

from . import config


@dataclass(frozen=True)
class NodeKind:
    type: str
    label: str
    blurb: str
    default_name: str
    default_description: str
    required: tuple[str, ...] = ()
    optional: tuple[str, ...] = ()
    is_source: bool = False
    default_config: dict[str, str] = field(default_factory=dict)
    hint: str = ""  # how to fill the parameters, shown to the model (the exact syntax the engine can run)


NODE_KINDS: list[NodeKind] = [
    NodeKind("INPUT", "Input", "Receive data to start a flow", "New input", "Receive input data.",
             required=("source",), is_source=True, default_config={"source": "manual"}),
    NodeKind("READ_FILE", "Read file", "Load a file from disk", "Read file", "Load a file from a source.",
             required=("file",), is_source=True, default_config={"file": "document.txt"}),
    NodeKind("READ_CSV", "Read CSV", "Read rows from a CSV table", "Read CSV", "Read rows from a CSV file.",
             required=("file",), optional=("delimiter",), is_source=True, default_config={"file": "data.csv", "delimiter": ","},
             hint="file is the name of an uploaded dataset."),
    NodeKind("LLM", "LLM", "Process text with a local model", "Ask the model", "Structure text with a local model.",
             optional=("task",), default_config={"task": "summarise"}),
    NodeKind("FILTER", "Filter", "Keep rows that match a rule", "Filter records", "Keep records that match a condition.",
             required=("condition",), default_config={"condition": "score < 50"},
             hint="condition compares column names with values using < <= > >= == != contains in, joined by and / or, with brackets. "
                  "Examples: score < 50 ; status == shipped and quantity >= 20 ; region in (South, West) ; salary between 4000 and 6000. "
                  "Put brackets around an or: quantity >= 20 and (region == South or region == West). It is not SQL: no SELECT, no subqueries."),
    NodeKind("TRANSFORM", "Transform", "Reshape fields for the next step", "Transform data", "Reshape fields for the next step.",
             required=("operation",), default_config={"operation": "select columns"},
             hint="operation is exactly one of: select columns a, b | drop columns a, b | rename a to b | sort by a | sort by a desc | limit N | remove duplicates | remove duplicates by a, b | "
                  "group by a: count, average b, sum b, min b, max b | summarise: count, sum b | join other_dataset on a. "
                  "Use one TRANSFORM step per operation. The N highest or lowest: sort by a desc (or sort by a), then limit N."),
    NodeKind("DATABASE", "Database", "Save records to SQLite", "Save to database", "Store structured records.",
             required=("table",), default_config={"table": "records"}),
    NodeKind("HTTP_REQUEST", "HTTP request", "Fetch data from an endpoint", "Fetch data", "Request data from an endpoint.",
             required=("method", "url"), is_source=True, default_config={"method": "GET", "url": "https://example.local/data"}),
    NodeKind("OUTPUT", "Output", "Deliver the final result", "Output", "Prepare workflow results.",
             required=("format",), default_config={"format": "table"}),
]

BY_TYPE: dict[str, NodeKind] = {k.type: k for k in NODE_KINDS}
TYPES: list[str] = [k.type for k in NODE_KINDS]


def catalogue_text() -> str:
    """The operation list as shown to the model."""
    lines = []
    for k in NODE_KINDS:
        keys = [f"{key} (required)" for key in k.required] + [f"{key} (optional)" for key in k.optional]
        params = ", ".join(keys) if keys else "none"
        start = " Can start a workflow." if k.is_source else ""
        lines.append(f"- {k.type}: {k.blurb}.{start} Parameters: {params}.{' ' + k.hint if k.hint and config.SYNTAX_HINTS else ''}")
    return "\n".join(lines)

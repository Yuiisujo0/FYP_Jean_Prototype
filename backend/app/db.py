"""SQLite storage. One file, no server. Swap for Postgres later by replacing this module.

Tables:
- workflow_patterns: example workflows shown to the model before it generates (the retrieval library)
- datasets: the user's data library (an uploaded CSV, kept until replaced or deleted). Rows are stored as JSON.
"""
import json
import sqlite3
import time
from contextlib import contextmanager
from typing import Iterator

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS datasets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    filename   TEXT NOT NULL,
    columns    TEXT NOT NULL,
    rows       TEXT NOT NULL,
    row_count  INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_patterns (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    title       TEXT NOT NULL,
    request     TEXT NOT NULL,
    steps       TEXT NOT NULL,
    op_sequence TEXT NOT NULL,
    verified    INTEGER NOT NULL,
    meta        TEXT NOT NULL DEFAULT '{}'
);
"""


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _summary(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "name": row["name"], "filename": row["filename"],
        "columns": json.loads(row["columns"]), "rowCount": row["row_count"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"],
    }


def list_datasets() -> list[dict]:
    with connect() as c:
        return [_summary(r) for r in c.execute("SELECT * FROM datasets ORDER BY updated_at DESC")]


def get_dataset(dataset_id: int) -> dict | None:
    with connect() as c:
        row = c.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
    return None if row is None else {**_summary(row), "rows": json.loads(row["rows"])}


def save_dataset(name: str, filename: str, columns: list[str], rows: list[dict[str, str]]) -> dict:
    """Insert, or replace the data under an existing name (so a workflow keeps pointing at it)."""
    now = int(time.time() * 1000)
    with connect() as c:
        c.execute(
            """INSERT INTO datasets (name, filename, columns, rows, row_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET filename=excluded.filename, columns=excluded.columns,
                 rows=excluded.rows, row_count=excluded.row_count, updated_at=excluded.updated_at""",
            (name, filename, json.dumps(columns), json.dumps(rows), len(rows), now, now),
        )
        row = c.execute("SELECT id FROM datasets WHERE name = ?", (name,)).fetchone()
    return get_dataset(row["id"])  # type: ignore[return-value]


def append_rows(dataset_id: int, rows: list[dict[str, str]]) -> dict | None:
    """Add rows (already keyed by the dataset's own column names) to the end of a dataset."""
    existing = get_dataset(dataset_id)
    if existing is None:
        return None
    merged = existing["rows"] + rows
    with connect() as c:
        c.execute(
            "UPDATE datasets SET rows = ?, row_count = ?, updated_at = ? WHERE id = ?",
            (json.dumps(merged), len(merged), int(time.time() * 1000), dataset_id),
        )
    return get_dataset(dataset_id)


def delete_dataset(dataset_id: int) -> bool:
    with connect() as c:
        return c.execute("DELETE FROM datasets WHERE id = ?", (dataset_id,)).rowcount > 0


# ---------- workflow patterns (the retrieval library) ----------

def replace_patterns(source: str, patterns: list[dict]) -> int:
    """Replace every pattern from `source` with `patterns` (keys: id, title, request, steps, verified, meta)."""
    with connect() as c:
        c.execute("DELETE FROM workflow_patterns WHERE source = ?", (source,))
        c.executemany(
            "INSERT INTO workflow_patterns (id, source, title, request, steps, op_sequence, verified, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(p["id"], source, p["title"], p["request"], json.dumps(p["steps"]), ">".join(s["type"] for s in p["steps"]),
              int(p.get("verified", False)), json.dumps(p.get("meta", {}))) for p in patterns],
        )
    return len(patterns)


def list_patterns() -> list[dict]:
    with connect() as c:
        rows = c.execute("SELECT * FROM workflow_patterns ORDER BY id").fetchall()
    return [{"id": r["id"], "source": r["source"], "title": r["title"], "request": r["request"], "steps": json.loads(r["steps"]),
             "opSequence": r["op_sequence"], "verified": bool(r["verified"]), "meta": json.loads(r["meta"])} for r in rows]


def patterns_stamp() -> tuple[int, str]:
    """Changes whenever the stored patterns change; lets the retrieval index rebuild itself."""
    with connect() as c:
        row = c.execute("SELECT COUNT(*) AS n, COALESCE(group_concat(id), '') AS ids FROM workflow_patterns").fetchone()
    return row["n"], row["ids"]

"""Loads the project's example workflows into the pattern table when it is empty."""
import json
import logging
from pathlib import Path

from . import db

log = logging.getLogger("jwork.patterns")
TASKS = Path(__file__).resolve().parents[1] / "eval" / "tasks.json"


def seed_if_empty() -> int:
    if db.list_patterns() or not TASKS.exists():
        return 0
    data = json.loads(TASKS.read_text(encoding="utf-8"))
    patterns = [
        {"id": t["id"], "title": t["title"], "request": t["request"], "steps": t["steps"], "verified": t["verified"],
         "meta": {"origin": "written for this project", "dataset": t["dataset"]}}
        for t in data["tasks"] if t["split"] == "library"
    ]
    n = db.replace_patterns("library", patterns)
    log.info("loaded %d example workflows into the pattern library", n)
    return n

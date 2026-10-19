"""Loads the library tasks from eval/tasks.json into the database as workflow patterns.

    python scripts/build_patterns.py [--db PATH]

Only tasks with split="library" are loaded. The held-out "test" tasks never reach the database, so retrieval cannot
leak the evaluation answers into the model's prompt.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import config, db  # noqa: E402

SOURCE = "library"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None)
    args = ap.parse_args()
    if args.db:
        config.DB_PATH = args.db

    data = json.loads((Path(__file__).resolve().parents[1] / "eval" / "tasks.json").read_text(encoding="utf-8"))
    patterns = [
        {"id": t["id"], "title": t["title"], "request": t["request"], "steps": t["steps"], "verified": t["verified"],
         "meta": {"origin": "written for this project", "dataset": t["dataset"]}}
        for t in data["tasks"] if t["split"] == "library"
    ]
    n = db.replace_patterns(SOURCE, patterns)
    print(f"stored {n} patterns ({sum(p['verified'] for p in patterns)} verified by execution) in {config.DB_PATH}")


if __name__ == "__main__":
    main()

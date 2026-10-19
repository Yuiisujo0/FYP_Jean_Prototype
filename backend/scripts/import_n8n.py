"""Converts a folder of n8n workflow JSON files into workflow patterns and reports how many survive.

    python -I scripts/import_n8n.py <folder with n8n workflow JSON files>

Prints how many workflows can be expressed in the 9 operations, and why the others cannot. It saves nothing: the
collections tried so far (see FYP_context_summary.md) were not usable as retrieval data. The folder is untrusted
input: files are only parsed as JSON.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # so `app` imports work under python -I

from app.n8n_import import convert  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    args = ap.parse_args()

    root = Path(args.folder)
    files = sorted(root.rglob("*.json"))
    reasons: Counter = Counter()
    unmapped: Counter = Counter()
    first_unmapped: Counter = Counter()
    patterns: list[dict] = []
    seen_titles: set[str] = set()
    unreadable = 0

    for f in files:
        try:
            wf = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            unreadable += 1
            continue
        rel = f.relative_to(root).as_posix()
        res = convert(wf, rel)
        if not res.ok:
            reasons[res.reason] += 1
            if res.reason == "unmapped node types":
                unmapped.update(set(res.detail))
                if len(set(res.detail)) == 1:
                    first_unmapped[res.detail[0]] += 1   # workflows that ONLY miss this one type
            continue
        key = res.pattern["title"].lower()
        if key in seen_titles:
            reasons["duplicate title"] += 1
            continue
        seen_titles.add(key)
        res.pattern["sourcePath"] = rel
        patterns.append(res.pattern)

    total = len(files)
    print(f"files: {total}   unreadable: {unreadable}")
    print(f"ACCEPTED: {len(patterns)} ({len(patterns) / max(total, 1):.1%})")
    q = Counter(p["quality"] for p in patterns)
    print(f"  exact mapping: {q['exact']}   approximate: {q['approx']}")
    print("\nrejected, by reason:")
    for reason, n in reasons.most_common():
        print(f"  {n:5d}  {reason}")
    print("\nmost common unmapped node types (workflows containing them):")
    for t, n in unmapped.most_common(25):
        print(f"  {n:5d}  {t}")
    print("\nunmapped types that are the ONLY blocker (adding them to the mapping would rescue N workflows):")
    for t, n in first_unmapped.most_common(15):
        print(f"  {n:5d}  {t}")
    print("\nlength of accepted patterns:", dict(sorted(Counter(len(p["steps"]) for p in patterns).items())))
    print("most common operation sequences:")
    for seq, n in Counter(p["opSequence"] for p in patterns).most_common(12):
        print(f"  {n:4d}  {seq}")



if __name__ == "__main__":
    main()

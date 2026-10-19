"""Chooses the reference examples shown to the model before it generates.

Three modes (config.RETRIEVAL, or the `mode` argument):
- "patterns": BM25 over the stored workflow patterns (the project's example library).
- "notes":    keyword match over the 6 built-in notes (the original behaviour).
- "none":     nothing, so generation uses the prompt and the operation catalogue alone.

Callers only rely on `retrieve(prompt, limit, mode)`.
"""
import math
import re
from collections import Counter

from . import config, db
from .knowledge import KNOWLEDGE, KnowledgeEntry

STOP = set("the a an and or of to in for with from then that this is are it its be on as by at into each me my all just only".split())
KEY_PARAM = {"READ_CSV": "file", "FILTER": "condition", "TRANSFORM": "operation", "DATABASE": "table", "HTTP_REQUEST": "url",
             "LLM": "task", "OUTPUT": "format", "READ_FILE": "file", "INPUT": "source"}


def tokens(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9_]{2,}", text.lower()) if w not in STOP]


class Bm25:
    def __init__(self, docs: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.docs, self.k1, self.b = docs, k1, b
        self.avg = (sum(len(d) for d in docs) / len(docs)) if docs else 0.0
        df = Counter(t for d in docs for t in set(d))
        n = len(docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def score(self, query: list[str], i: int) -> float:
        doc, tf, total = self.docs[i], Counter(self.docs[i]), 0.0
        for q in set(query):
            if q in tf:
                total += self.idf[q] * tf[q] * (self.k1 + 1) / (tf[q] + self.k1 * (1 - self.b + self.b * len(doc) / (self.avg or 1)))
        return total


_cache: dict = {"stamp": None, "patterns": [], "index": None}


def _index() -> tuple[list[dict], Bm25 | None]:
    stamp = db.patterns_stamp()
    if _cache["stamp"] != stamp:
        patterns = db.list_patterns()
        # Retrieval matches on what the user would type (the request and title), not on step parameters.
        _cache.update(stamp=stamp, patterns=patterns, index=Bm25([tokens(f"{p['title']} {p['request']}") for p in patterns]) if patterns else None)
    return _cache["patterns"], _cache["index"]


def describe_steps(steps: list[dict]) -> str:
    out = []
    for s in steps:
        key = KEY_PARAM.get(s["type"], "")
        value = s["config"].get(key, "")
        out.append(f"{s['type']}({value})" if value else s["type"])
    return " > ".join(out)


def _notes(prompt: str, limit: int) -> list[KnowledgeEntry]:
    words = set(re.findall(r"[a-z]{3,}", prompt.lower()))
    scored = []
    for entry in KNOWLEDGE:
        haystack = f"{entry.title} {entry.category} {entry.summary} {entry.detail}".lower()
        scored.append((sum(1 for w in words if w in haystack), entry))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [entry for _, entry in scored[:limit]]


def _patterns(prompt: str, limit: int) -> list[KnowledgeEntry]:
    patterns, index = _index()
    if not patterns or index is None:
        return []
    query = tokens(prompt)
    ranked = sorted(((index.score(query, i), i) for i in range(len(patterns))), reverse=True)
    out = []
    for score, i in ranked[:limit]:
        if score <= 0:
            break
        p = patterns[i]
        out.append(KnowledgeEntry(
            id=p["id"], title=p["title"], category="Pattern", summary=p["request"],
            detail=f"For example \"{p['request']}\" is {describe_steps(p['steps'])}.",
        ))
    return out


def retrieve(prompt: str, limit: int = 2, mode: str | None = None) -> list[KnowledgeEntry]:
    mode = mode or config.RETRIEVAL
    if mode == "none":
        return []
    if mode == "patterns":
        return _patterns(prompt, limit)
    return _notes(prompt, limit)

"""Reference patterns the model is shown before it generates. Mirrors src/data/knowledge.ts.

This is the retrieval corpus. It will grow into the workflow dataset (30-50 workflows in the project schema).
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class KnowledgeEntry:
    id: str
    title: str
    category: str
    summary: str
    detail: str


KNOWLEDGE: list[KnowledgeEntry] = [
    KnowledgeEntry("csv", "Working with CSV input", "Data sources",
                   "Read tabular files and identify the fields your workflow needs.",
                   "A CSV reading step needs a file path, a delimiter, and a header row containing stable column names. Later steps refer to those column names, so keep them consistent."),
    KnowledgeEntry("filters", "Filter conditions", "Data preparation",
                   "Keep records that meet a clear, testable condition.",
                   "Use explicit comparisons such as score < 50. Conditions should refer to fields that exist in the incoming records, and each filter should test one idea."),
    KnowledgeEntry("records", "Saving structured records", "Storage patterns",
                   "Map selected fields into a predictable record shape.",
                   "Choose the destination table and name the fields that should be preserved for later review. Saving after filtering keeps the table small and relevant."),
    KnowledgeEntry("linear", "Linear workflow patterns", "Workflow design",
                   "Arrange each operation so its input comes from the previous step.",
                   "A clear linear workflow begins with an input, performs one or more transformations, and ends with an output. Avoid branching until the linear case is reliable."),
    KnowledgeEntry("llm", "Summarising text with an LLM", "AI steps",
                   "Turn documents or records into short summaries and labels.",
                   "An LLM step takes text from the previous step and returns structured text. Keep the task specific, such as summarise or classify, so the output is predictable."),
    KnowledgeEntry("http", "Fetching data over HTTP", "Data sources",
                   "Pull JSON from an endpoint and pass it to the next step.",
                   "An HTTP step needs a method and a URL. Treat the response as a source: follow it with a transform to pick the fields you need before storing or reporting."),
]

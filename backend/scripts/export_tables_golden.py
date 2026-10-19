"""Records what the Python table reader (app/tables.py) produces, for the browser reader (src/lib/tables.ts) to match.

    python scripts/export_tables_golden.py

Writes backend/eval/fixtures/edge.xlsx and backend/eval/golden_tables.json. tests/tables.test.ts reads both.
"""
import json
import sys
from datetime import date, datetime, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from openpyxl import Workbook  # noqa: E402

from app.tables import parse_csv, parse_xlsx  # noqa: E402

PROJECT = ROOT.parent
FIXTURES = ROOT / "eval" / "fixtures"
FIXTURES.mkdir(exist_ok=True)

# ---- an Excel file full of edge cases ----
wb = Workbook()
empty = wb.active
empty.title = "Empty first sheet"           # the reader must skip a sheet with no data
ws = wb.create_sheet("Data")
ws["C3"], ws["D3"], ws["E3"], ws["F3"] = "  Name  ", "Amount", "When", "Note"      # header starts at C3, with spaces
ws.append([])                                                                      # a blank row (row 4 is written below)
rows = [
    ("Ali & Sons <Ltd>", 1234.5678, datetime(2026, 3, 1), "plain"),
    ("Émile ☕", 0.1, datetime(2026, 3, 2, 14, 30, 15), "has time"),
    ("whole", 42.0, date(2026, 3, 3), None),
    ("big", 1_000_000, datetime(2026, 12, 31, 0, 0, 0), "=1+1"),                   # a formula: no cached value
    ("flag", True, time(9, 5, 0), "time only"),
    ("neg", -7.25, datetime(1999, 1, 2), "old date"),
    ("tiny", 0.000123, datetime(2026, 1, 1, 0, 0, 1), ""),
]
for i, (a, b, c, d) in enumerate(rows):
    r = 5 + i
    ws.cell(row=r, column=3, value=a)
    ws.cell(row=r, column=4, value=b)
    c_cell = ws.cell(row=r, column=5, value=c)
    if isinstance(c, time):
        c_cell.number_format = "hh:mm:ss"
    ws.cell(row=r, column=6, value=d)
ws.cell(row=14, column=3, value="after a gap")
ws.cell(row=14, column=4, value=3)
wb.save(FIXTURES / "edge.xlsx")

xlsx_cases = []
for path in sorted([*(PROJECT / "sample_data").glob("*.xlsx"), FIXTURES / "edge.xlsx"]):
    columns, parsed_rows, sheet = parse_xlsx(path.read_bytes())
    rel = path.relative_to(PROJECT).as_posix()
    xlsx_cases.append({"path": rel, "columns": columns, "rows": parsed_rows, "sheet": sheet})

# ---- CSV text cases ----
csv_inputs = {
    "sample": ((PROJECT / "sample_data" / "student_marks.csv").read_text(encoding="utf-8"), ","),
    "bom_quotes_newlines": ('﻿name,notes,,\r\n"Ali, Jr.","line one\nline two",x,\r\n"say ""hi""",plain,,\r\n\r\n   ,  ,,\r\nshort\r\n', ","),
    "duplicate_headers": ("a,A,b\n1,2,3\n", ","),
    "empty": ("", ","),
    "only_blank_lines": ("\n\n  \n", ","),
    "blank_header_cell": ("a,,c\n1,2,3\n", ","),
    "semicolon": ("a;b\n1;2\n3;4\n", ";"),
    "unicode": ("名前,città\n山田,Roma\n", ","),
    "padding": ("  a , b \n  1 ,  2  \n", ","),
    "extra_cells": ("a,b\n1,2,3,4\n5\n", ","),
    "header_only": ("a,b\n", ","),
    "cr_only": ("a,b\r1,2\r3,4", ","),
    "quote_inside_unquoted": ("a,b\nab\"c,d\n", ","),
}
csv_cases = []
for name, (text, delimiter) in csv_inputs.items():
    entry = {"name": name, "text": text, "delimiter": delimiter}
    try:
        columns, parsed_rows = parse_csv(text, delimiter)
        entry["expected"] = {"columns": columns, "rows": parsed_rows}
    except ValueError as e:
        entry["error"] = str(e)
    csv_cases.append(entry)

(ROOT / "eval" / "golden_tables.json").write_text(json.dumps({"xlsx": xlsx_cases, "csv": csv_cases}, indent=1, ensure_ascii=False), encoding="utf-8")
print(f"{len(xlsx_cases)} xlsx files, {len(csv_cases)} csv cases")
for c in xlsx_cases:
    print(f"  {c['path']}: sheet {c['sheet']!r}, {len(c['rows'])} rows, columns {c['columns']}")
errors = [c["name"] for c in csv_cases if "error" in c]
print("csv cases that are errors:", errors)

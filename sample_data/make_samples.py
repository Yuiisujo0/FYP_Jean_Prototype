"""Makes the mock Excel files in this folder. Run from the project root:

    backend\\.venv\\Scripts\\python sample_data\\make_samples.py

All data is invented. A fixed random seed means the files come out the same every time.
"""
import random
from datetime import date, timedelta
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font

OUT = Path(__file__).parent
FIRST = ["Steel", "Blue", "Heavy", "Compact", "Red", "Large", "Small", "Black", "Green", "Cordless", "Folding", "Clear",
         "Rubber", "Plastic", "Wooden", "Grey", "White", "Yellow", "Metal", "Portable", "Spare", "Basic", "Premium", "Round"]
LAST = ["Stapler", "Drill", "Cable", "Shelf", "Tape", "Helmet", "Gloves", "Ladder", "Binder", "Trolley", "Printer", "Toolbox"]
CATEGORIES = ["Tools", "Office", "Safety"]


def stock_rows(seed: int, count: int, start_id: int, period_start: date):
    rnd = random.Random(seed)
    for i in range(count):
        stock = rnd.choice([rnd.randint(20, 49), rnd.randint(50, 95), rnd.randint(50, 95)])
        yield [
            f"SKU{start_id + i:04d}",
            f"{rnd.choice(FIRST)} {rnd.choice(LAST)}",
            rnd.choice(CATEGORIES),
            stock,
            rnd.randint(55, 100),
            period_start + timedelta(days=rnd.randint(0, 90)),
        ]


def write(path: Path, header: list[str], rows: list[list], sheet: str = "Sheet1", blank_after: int | None = None):
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append(header)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for i, row in enumerate(rows):
        ws.append(row)
        if blank_after is not None and i == blank_after:
            ws.append([])  # a stray blank row, as real spreadsheets have
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = 18
    wb.save(path)
    print(f"{path.name}: {len(rows)} rows")


HEADER = ["sku", "name", "category", "stock", "reorder_level", "last_counted"]

# 1. The main dataset. One item has no stock count (not counted yet), and there is a blank row in the middle.
main = list(stock_rows(seed=1, count=40, start_id=1, period_start=date(2026, 2, 1)))
main[6][3] = None
write(OUT / "stock_list.xlsx", HEADER, main, sheet="Stock", blank_after=19)

# 2. Next month: same columns, different items. Try it as "Replace" (or "Save as new").
write(OUT / "stock_list_next_month.xlsx", HEADER, list(stock_rows(seed=2, count=30, start_id=101, period_start=date(2026, 8, 1))), sheet="Stock")

# 3. A few late counts: same columns. Try it as "Add rows".
write(OUT / "stock_list_late_counts.xlsx", HEADER, list(stock_rows(seed=3, count=6, start_id=201, period_start=date(2026, 3, 1))), sheet="Late")

# 4. Same data, but headers written the way people type them. Matching ignores case and punctuation.
write(OUT / "stock_list_other_headers.xlsx",
      ["SKU", "Name", "Category", "Stock", "Reorder Level", "Last Counted"],
      list(stock_rows(seed=4, count=8, start_id=301, period_start=date(2026, 4, 1))), sheet="Export")

# 5. A different kind of data: should be offered as a new dataset, not as an update.
write(OUT / "categories.xlsx", ["category_code", "category_name", "buyer", "lead_days"], [
    ["Tools", "Hand and power tools", "Ms Aminah", 4],
    ["Office", "Office supplies", "Mr Wong", 4],
    ["Safety", "Safety equipment", "Mr Ismail", 3],
], sheet="Categories")

# 6. The same main data as CSV, for comparison.
import csv
with open(OUT / "stock_list.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(HEADER)
    for r in main:
        w.writerow(["" if v is None else v for v in r])
print("stock_list.csv:", len(main), "rows")

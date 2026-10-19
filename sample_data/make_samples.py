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
FIRST = ["Amina", "Daniel", "Mei", "Rahim", "Siti", "Jason", "Nurul", "Kevin", "Aisyah", "Ivan", "Farah", "Lim",
         "Hafiz", "Chloe", "Zul", "Priya", "Marcus", "Dayang", "Alvin", "Syafiqah", "Ethan", "Nadia", "Bryan", "Hana"]
LAST = ["Abdullah", "Tan", "Wong", "Ismail", "Lee", "Anak Jaban", "Hassan", "Ng", "Yusof", "Chong", "Rahman", "Lau"]
COURSES = ["CS101", "CS102", "MATH201"]


def students(seed: int, count: int, start_id: int, semester_start: date):
    rnd = random.Random(seed)
    for i in range(count):
        score = rnd.choice([rnd.randint(20, 49), rnd.randint(50, 95), rnd.randint(50, 95)])
        yield [
            f"S{start_id + i:04d}",
            f"{rnd.choice(FIRST)} {rnd.choice(LAST)}",
            rnd.choice(COURSES),
            score,
            rnd.randint(55, 100),
            semester_start + timedelta(days=rnd.randint(0, 90)),
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


HEADER = ["student_id", "name", "course", "score", "attendance_pct", "submitted"]

# 1. The main dataset. One student has no score (absent), and there is a blank row in the middle.
main = list(students(seed=1, count=40, start_id=1, semester_start=date(2026, 2, 1)))
main[6][3] = None
write(OUT / "student_marks.xlsx", HEADER, main, sheet="Marks", blank_after=19)

# 2. Next semester: same columns, different students. Try it as "Replace" (or "Save as new").
write(OUT / "student_marks_next_semester.xlsx", HEADER, list(students(seed=2, count=30, start_id=101, semester_start=date(2026, 8, 1))), sheet="Marks")

# 3. A few late submissions: same columns. Try it as "Add rows".
write(OUT / "student_marks_late_submissions.xlsx", HEADER, list(students(seed=3, count=6, start_id=201, semester_start=date(2026, 3, 1))), sheet="Late")

# 4. Same data, but headers written the way people type them. Matching ignores case and punctuation.
write(OUT / "student_marks_other_headers.xlsx",
      ["Student ID", "Name", "Course", "Score", "Attendance Pct", "Submitted"],
      list(students(seed=4, count=8, start_id=301, semester_start=date(2026, 4, 1))), sheet="Export")

# 5. A different kind of data: should be offered as a new dataset, not as an update.
write(OUT / "courses.xlsx", ["course_code", "course_name", "lecturer", "credits"], [
    ["CS101", "Introduction to Programming", "Dr. Aminah", 4],
    ["CS102", "Data Structures", "Dr. Wong", 4],
    ["MATH201", "Discrete Mathematics", "Dr. Ismail", 3],
], sheet="Courses")

# 6. The same main data as CSV, for comparison.
import csv
with open(OUT / "student_marks.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(HEADER)
    for r in main:
        w.writerow(["" if v is None else v for v in r])
print("student_marks.csv:", len(main), "rows")

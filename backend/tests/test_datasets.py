import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app

CSV = "student,score\nAmina,42\nDaniel,67\n\nMei,38\n"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "test.db"))
    return TestClient(app)


def upload(client, name="marks", content=CSV):
    return client.post("/api/datasets", json={"name": name, "filename": "marks.csv", "content": content})


def test_upload_parses_columns_and_skips_blank_rows(client):
    res = upload(client)
    assert res.status_code == 200
    body = res.json()
    assert body["columns"] == ["student", "score"]
    assert body["rowCount"] == 3
    assert body["rows"][2] == {"student": "Mei", "score": "38"}


def test_same_name_replaces_data_and_keeps_the_id(client):
    first = upload(client).json()
    second = upload(client, content="student,score\nRahim,81\n").json()
    assert second["id"] == first["id"]
    assert second["rowCount"] == 1
    assert len(client.get("/api/datasets").json()) == 1


def test_list_does_not_include_rows(client):
    upload(client)
    assert "rows" not in client.get("/api/datasets").json()[0]


def test_get_and_delete(client):
    dataset_id = upload(client).json()["id"]
    assert client.get(f"/api/datasets/{dataset_id}").json()["name"] == "marks"
    assert client.delete(f"/api/datasets/{dataset_id}").status_code == 200
    assert client.get(f"/api/datasets/{dataset_id}").status_code == 404


def test_bad_files_are_rejected(client):
    assert upload(client, content="").status_code == 422
    assert upload(client, content="a,a\n1,2\n").status_code == 422


# ---------- Excel, inspect, replace / add rows / new ----------

import base64
from pathlib import Path

SAMPLES = Path(__file__).resolve().parents[2] / "sample_data"


def xlsx(name):
    return {"filename": name, "contentBase64": base64.b64encode((SAMPLES / name).read_bytes()).decode()}


def test_excel_is_read_with_blank_cells_blank_rows_and_dates(client):
    res = client.post("/api/datasets", json={"name": "marks", **xlsx("student_marks.xlsx")})
    assert res.status_code == 200
    body = res.json()
    assert body["columns"] == ["student_id", "name", "course", "score", "attendance_pct", "submitted"]
    assert body["rowCount"] == 40  # the stray blank row is skipped
    assert body["rows"][6]["score"] == ""  # the absent student keeps a blank score
    assert body["rows"][0]["score"].isdigit()  # 42, not 42.0
    assert len(body["rows"][0]["submitted"]) == 10  # an ISO date such as 2026-02-14


def test_inspect_reports_matches_without_saving(client):
    client.post("/api/datasets", json={"name": "student_marks", **xlsx("student_marks.xlsx")})
    info = client.post("/api/datasets/inspect", json=xlsx("student_marks_next_semester.xlsx")).json()
    assert info["rowCount"] == 30 and info["sheet"] == "Marks"
    [match] = info["matches"]
    assert match["sameColumns"] is True and match["sameName"] is False
    assert len(client.get("/api/datasets").json()) == 1  # nothing new was saved

    unrelated = client.post("/api/datasets/inspect", json=xlsx("courses.xlsx")).json()
    assert unrelated["matches"] == []


def test_same_file_name_counts_as_same_name(client):
    client.post("/api/datasets", json={"name": "student_marks", **xlsx("student_marks.xlsx")})
    info = client.post("/api/datasets/inspect", json=xlsx("student_marks.xlsx")).json()
    assert info["matches"][0]["sameName"] is True


def test_append_adds_rows_even_when_headers_are_typed_differently(client):
    target = client.post("/api/datasets", json={"name": "marks", **xlsx("student_marks.xlsx")}).json()
    res = client.post("/api/datasets", json={"mode": "append", "targetId": target["id"], **xlsx("student_marks_other_headers.xlsx")})
    assert res.status_code == 200
    body = res.json()
    assert body["rowCount"] == 48
    assert body["columns"] == target["columns"]  # the dataset keeps its own column names
    assert body["rows"][-1]["attendance_pct"].isdigit()


def test_append_rejects_different_columns(client):
    target = client.post("/api/datasets", json={"name": "marks", **xlsx("student_marks.xlsx")}).json()
    res = client.post("/api/datasets", json={"mode": "append", "targetId": target["id"], **xlsx("courses.xlsx")})
    assert res.status_code == 422 and "do not match" in res.json()["detail"]


def test_new_refuses_an_existing_name_and_replace_swaps_the_data(client):
    client.post("/api/datasets", json={"name": "marks", **xlsx("student_marks.xlsx")})
    assert client.post("/api/datasets", json={"name": "Marks", "mode": "new", **xlsx("courses.xlsx")}).status_code == 409
    replaced = client.post("/api/datasets", json={"name": "marks", "mode": "replace", **xlsx("student_marks_next_semester.xlsx")}).json()
    assert replaced["rowCount"] == 30 and len(client.get("/api/datasets").json()) == 1


def test_broken_excel_is_a_clear_error_not_a_crash(client):
    bad = {"filename": "x.xlsx", "contentBase64": base64.b64encode(b"not a zip").decode()}
    res = client.post("/api/datasets/inspect", json=bad)
    assert res.status_code == 422 and "not a valid .xlsx" in res.json()["detail"]
    assert client.post("/api/datasets/inspect", json={"filename": "old.xls", "contentBase64": "AAAA"}).status_code == 422


def test_generate_uses_datasets_sent_by_the_browser_else_the_library(client, monkeypatch):
    from app.routes import generate as route

    seen = []

    async def fake_generate(prompt, model, datasets, *args, **kwargs):
        seen.append(datasets)
        raise route.OllamaError("stop here")

    monkeypatch.setattr(route, "generate_workflow", fake_generate)
    upload(client)
    client.post("/api/generate", json={"prompt": "read the marks", "datasets": [{"name": "sent", "columns": ["a", "b"]}]})
    client.post("/api/generate", json={"prompt": "read the marks"})
    client.post("/api/generate", json={"prompt": "read the marks", "datasets": []})
    assert seen[0] == [{"name": "sent", "columns": ["a", "b"]}]          # what the browser sent
    assert [d["name"] for d in seen[1]] == ["marks"]                      # nothing sent: the backend's own library
    assert seen[2] == []                                                   # an explicit empty list means "no datasets"
    assert client.post("/api/generate", json={"prompt": "read the marks", "datasets": [{"name": "", "columns": []}]}).status_code == 422


def test_csv_with_any_line_ending_is_read_and_never_crashes(client):
    for ending in ("\n", "\r\n", "\r"):
        res = upload(client, name="x", content=f"a,b{ending}1,2{ending}3,4")
        assert res.status_code == 200, repr(ending)
        assert res.json()["rowCount"] == 2

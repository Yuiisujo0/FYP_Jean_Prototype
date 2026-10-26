import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app import config, llm
from app.errors import OllamaError
from app.llm import normalize_config, refine_messages, refine_workflow
from app.main import app

STEPS = [
    {"type": "READ_CSV", "config": {"file": "marks", "delimiter": ","}},
    {"type": "FILTER", "config": {"condition": "score < 50"}},
    {"type": "OUTPUT", "config": {"format": "table"}},
]


def answer(steps):
    """What a model would say: flat step objects."""
    return json.dumps({"steps": [{"type": s["type"], **s["config"]} for s in steps]})


def fake_model(monkeypatch, *replies):
    calls = []

    async def fake_chat(model, messages, schema, temperature=0.1, num_ctx=None):
        calls.append({"messages": [dict(m) for m in messages], "temperature": temperature})
        text = replies[min(len(calls) - 1, len(replies) - 1)]
        return text, {"eval_count": 10, "prompt_tokens": 100, "load_ms": 0, "prompt_ms": 0, "gen_ms": 0}

    monkeypatch.setattr(llm, "chat_json", fake_chat)
    return calls


def test_the_model_is_shown_the_workflow_and_the_instruction_and_no_data():
    messages = refine_messages(STEPS, "change the filter to 40", [{"name": "marks", "columns": ["name", "score"]}])
    assert [m["role"] for m in messages] == ["system", "user"]
    assert "Change only what the instruction asks for" in messages[0]["content"]
    assert "- marks: columns name, score" in messages[0]["content"]
    assert '{"steps":[{"type":"READ_CSV","file":"marks","delimiter":","}' in messages[1]["content"]
    assert messages[1]["content"].endswith("Instruction: change the filter to 40")


def test_a_change_is_reported_and_the_steps_come_back_named(monkeypatch):
    changed = [STEPS[0], {"type": "FILTER", "config": {"condition": "score < 40"}}, STEPS[2]]
    calls = fake_model(monkeypatch, answer(changed))
    result = asyncio.run(refine_workflow(STEPS, "change the filter to 40", "m"))
    assert result.unchanged is False and result.valid
    assert [n.config.get("condition") for n in result.nodes if n.type == "FILTER"] == ["score < 40"]
    assert result.nodes[1].name == "Filter: score < 40"
    assert len(calls) == 1 and calls[0]["temperature"] == 0.1


def test_the_same_workflow_back_is_reported_as_unchanged_even_if_written_differently(monkeypatch):
    # No delimiter in the input, extra spaces and a default filled in by the model: still the same workflow.
    steps_in = [{"type": "READ_CSV", "config": {"file": "marks"}}, {"type": "FILTER", "config": {"condition": " score < 50 "}}, STEPS[2]]
    fake_model(monkeypatch, answer(STEPS))
    assert asyncio.run(refine_workflow(steps_in, "make the world better", "m")).unchanged is True


def test_an_invalid_answer_is_repaired_like_in_generation(monkeypatch):
    broken = [STEPS[0], {"type": "FILTER", "config": {"condition": ""}}, STEPS[2]]   # a required value left blank
    calls = fake_model(monkeypatch, answer(broken), answer(STEPS))
    result = asyncio.run(refine_workflow(STEPS, "blank the filter", "m"))
    assert len(result.attempts) == 2 and result.attempts[0].errors == 1 and result.valid
    assert calls[1]["temperature"] == 0.5
    assert "needs a value for “condition”" in calls[1]["messages"][-1]["content"]


def test_unusable_answers_end_in_an_error_that_knows_what_was_spent(monkeypatch):
    fake_model(monkeypatch, "nonsense")
    with pytest.raises(OllamaError) as e:
        asyncio.run(refine_workflow(STEPS, "do something", "m"))
    assert len(e.value.attempts) == 3


def test_normalize_config_trims_defaults_and_drops_empties():
    assert normalize_config("READ_CSV", {"file": " x ", "delimiter": ""}) == {"file": "x", "delimiter": ","}
    assert normalize_config("FILTER", {"condition": "", "note": ""}) == {"condition": ""}   # blank required kept, blank extra dropped
    assert normalize_config("MYSTERY", {"a": " b "}) == {"a": "b"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "t.db"))
    with TestClient(app) as c:
        yield c


def test_the_route_returns_named_steps_and_whether_anything_changed(client, monkeypatch):
    fake_model(monkeypatch, answer([STEPS[0], {"type": "FILTER", "config": {"condition": "score < 40"}}, STEPS[2]]))
    res = client.post("/api/refine", json={"steps": STEPS, "instruction": "change the filter to 40", "datasets": []})
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"nodes", "valid", "issues", "unchanged", "attempts", "elapsedMs", "model"}
    assert body["unchanged"] is False and body["valid"] is True
    assert [n["type"] for n in body["nodes"]] == ["READ_CSV", "FILTER", "OUTPUT"]
    assert body["nodes"][1]["config"]["condition"] == "score < 40" and body["nodes"][1]["name"]


def test_the_route_refuses_bad_requests_and_reports_model_failures(client, monkeypatch):
    ok = {"steps": STEPS, "instruction": "change the filter to 40"}
    assert client.post("/api/refine", json={**ok, "instruction": "hi"}).status_code == 422
    assert client.post("/api/refine", json={**ok, "instruction": "x" * 301}).status_code == 422
    assert client.post("/api/refine", json={**ok, "steps": []}).status_code == 422
    assert client.post("/api/refine", json={**ok, "steps": STEPS * 4}).status_code == 422
    too_long = [{"type": "FILTER", "config": {"condition": "x" * 301}}]
    assert client.post("/api/refine", json={**ok, "steps": too_long}).status_code == 422
    fake_model(monkeypatch, "nonsense")
    res = client.post("/api/refine", json=ok)
    assert res.status_code == 502 and "usable workflow" in res.json()["detail"]


# ---------- revising after a test run (the agent's observe-and-revise step) ----------

OBSERVATION = "Step 2 (FILTER: Keeps only the rows where customer is Lim.) 40 rows in, 0 rows out.\nThe result has 0 rows."


def test_revise_shows_the_request_the_workflow_and_the_run_report():
    from app.llm import revise_messages
    messages = revise_messages("Orders from customers named Lim", STEPS, OBSERVATION, [{"name": "orders", "columns": ["customer", "total"]}])
    assert [m["role"] for m in messages] == ["system", "user"]
    assert "If the report is what the request should give, return the workflow unchanged." in messages[0]["content"]
    assert "- orders: columns customer, total" in messages[0]["content"]
    user = messages[1]["content"]
    assert user.startswith("Request: Orders from customers named Lim\n\nCurrent workflow:\n{\"steps\":[")
    assert user.endswith("What happened when it ran:\n" + OBSERVATION)


def test_the_revise_route_returns_the_revision(client, monkeypatch):
    fixed = [STEPS[0], {"type": "FILTER", "config": {"condition": "customer contains Lim"}}, STEPS[2]]
    calls = fake_model(monkeypatch, answer(fixed))
    res = client.post("/api/revise", json={"request": "Orders from customers named Lim", "steps": STEPS, "observation": OBSERVATION, "datasets": []})
    assert res.status_code == 200
    body = res.json()
    assert body["unchanged"] is False and body["valid"] is True
    assert body["nodes"][1]["config"]["condition"] == "customer contains Lim"
    assert "What happened when it ran:" in calls[0]["messages"][1]["content"]


def test_the_revise_route_refuses_bad_requests(client):
    ok = {"request": "Orders from customers named Lim", "steps": STEPS, "observation": OBSERVATION}
    assert client.post("/api/revise", json={**ok, "observation": ""}).status_code == 422
    assert client.post("/api/revise", json={**ok, "observation": "x" * 2001}).status_code == 422
    assert client.post("/api/revise", json={**ok, "request": "hi"}).status_code == 422
    assert client.post("/api/revise", json={**ok, "steps": []}).status_code == 422

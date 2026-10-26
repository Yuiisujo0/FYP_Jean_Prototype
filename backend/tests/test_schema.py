from app.llm import build_flow
from app.node_kinds import NODE_KINDS, TYPES
from app.schema import DraftWorkflow, draft_json_schema
from app.validate import error_count, validate_workflow


def test_every_supported_operation_has_exactly_one_schema_variant():
    variants = draft_json_schema()["properties"]["steps"]["items"]["anyOf"]
    assert [v["properties"]["type"]["enum"][0] for v in variants] == TYPES


def test_schema_requires_each_operations_parameters():
    variants = {v["properties"]["type"]["enum"][0]: v for v in draft_json_schema()["properties"]["steps"]["items"]["anyOf"]}
    for kind in NODE_KINDS:
        for key in kind.required:
            assert key in variants[kind.type]["required"], f"{kind.type} must force '{key}'"


def test_build_flow_fills_names_descriptions_and_edges():
    draft = DraftWorkflow(steps=[
        {"type": "READ_CSV", "file": "marks.csv", "delimiter": ","},
        {"type": "FILTER", "condition": "score < 50"},
        {"type": "OUTPUT", "format": "table"},
    ])
    flow = build_flow(draft, "Read marks and keep failing students")
    assert [n.name for n in flow.nodes] == ["Read marks.csv", "Filter: score < 50", "Output as table"]
    assert all(n.description for n in flow.nodes)
    assert len(flow.edges) == 2
    assert error_count(validate_workflow(flow.nodes, flow.edges)) == 0


def test_blank_optional_parameter_gets_its_default():
    draft = DraftWorkflow(steps=[
        {"type": "READ_CSV", "file": "marks.csv", "delimiter": ""},
        {"type": "OUTPUT", "format": "table"},
    ])
    flow = build_flow(draft, "Read marks")
    assert flow.nodes[0].config == {"file": "marks.csv", "delimiter": ","}


def test_blank_required_parameter_is_kept_so_the_validator_can_flag_it():
    draft = DraftWorkflow(steps=[
        {"type": "READ_CSV", "file": "", "delimiter": ","},
        {"type": "OUTPUT", "format": "table"},
    ])
    flow = build_flow(draft, "Read marks")
    assert "file" in flow.nodes[0].config
    assert any("needs a value" in i.message for i in validate_workflow(flow.nodes, flow.edges))


def test_prompt_lists_dataset_names_and_columns_but_never_rows():
    from app.llm import system_prompt

    datasets = [{"name": "Student marks", "columns": ["student", "score"], "rows": [{"student": "SECRET", "score": "1"}]}]
    text = system_prompt([], datasets)
    assert "Student marks: columns student, score" in text
    assert "SECRET" not in text
    assert "uploaded these datasets" not in system_prompt([], [])


def test_pattern_retrieval_ranks_by_request_and_seeds_an_empty_table(tmp_path, monkeypatch):
    from app import config, db
    from app.patterns_seed import seed_if_empty
    from app.retrieval import retrieve

    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "p.db"))
    assert retrieve("anything", mode="patterns") == []          # empty table: nothing, no crash
    assert seed_if_empty() > 0 and seed_if_empty() == 0         # seeds once, never twice
    top = retrieve("which items are below their reorder level", 2, "patterns")
    assert top and "reorder" in top[0].detail.lower()
    assert "READ_CSV(inventory)" in top[0].detail               # shows the steps and the key parameter
    assert retrieve("zzzz qqqq", 2, "patterns") == []           # no overlap, no noise
    assert retrieve("anything", mode="none") == []


# ---------- Cloudflare Workers AI adapter (no network: parse_response is pure) ----------

def test_cloudflare_parse_response_reads_text_objects_and_usage():
    from app.cloudflare import parse_response

    content, stats = parse_response(200, {"success": True, "result": {"response": '{"steps":[]}', "usage": {"prompt_tokens": 700, "completion_tokens": 60}}})
    assert content == '{"steps":[]}' and stats["prompt_tokens"] == 700 and stats["eval_count"] == 60
    content, _ = parse_response(200, {"success": True, "result": {"response": {"steps": []}}})   # some models return an object
    assert content == '{"steps": []}'
    # newer models answer in the OpenAI chat shape and report the neuron cost of the call
    content, stats = parse_response(200, {"success": True, "result": {"choices": [{"message": {"content": '{"steps":[1]}'}}], "usage": {"prompt_tokens": 5, "completion_tokens": 7, "neurons": 11.5}}})
    assert content == '{"steps":[1]}' and stats["neurons"] == 11.5


def test_cloudflare_errors_are_specific_and_json_mode_failure_is_retryable():
    import pytest

    from app.cloudflare import parse_response
    from app.errors import ModelOutputError, OllamaError

    with pytest.raises(OllamaError, match="daily allowance"):
        parse_response(429, {})
    with pytest.raises(OllamaError, match="credentials"):
        parse_response(401, {"errors": [{"message": "bad token"}]})
    with pytest.raises(ModelOutputError):
        parse_response(400, {"errors": [{"message": "JSON Mode couldn't be met"}]})
    with pytest.raises(OllamaError, match="500"):
        parse_response(500, {"errors": [{"message": "boom"}]})
    assert issubclass(ModelOutputError, OllamaError)
    with pytest.raises(ModelOutputError, match="no content"):
        parse_response(200, {"success": True, "result": {}})


def test_generation_retries_when_the_provider_rejects_its_own_output(monkeypatch):
    import asyncio

    from app import llm
    from app.errors import ModelOutputError

    calls = {"n": 0}

    async def fake_chat(model, messages, schema, temperature=0.1, num_ctx=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ModelOutputError("JSON Mode couldn't be met")
        return '{"steps":[{"type":"READ_CSV","file":"x","delimiter":","},{"type":"OUTPUT","format":"table"}]}', \
            {"eval_count": 10, "prompt_tokens": 100, "load_ms": 0, "prompt_ms": 0, "gen_ms": 0}

    monkeypatch.setattr(llm, "chat_json", fake_chat)
    result = asyncio.run(llm.generate_workflow("read x", "m", None, "none"))
    assert calls["n"] == 2 and result.valid
    assert result.attempts[0].errors == 1 and "rejected by provider" in result.attempts[0].note


def test_a_workflow_without_output_gets_one_and_keeps_its_last_step():
    draft = DraftWorkflow(steps=[
        {"type": "READ_CSV", "file": "marks.csv", "delimiter": ","},
        {"type": "FILTER", "condition": "score < 50"},
        {"type": "DATABASE", "table": "failed_students"},
    ])
    flow = build_flow(draft, "Flag failing students and save them")
    assert [n.type for n in flow.nodes] == ["READ_CSV", "FILTER", "DATABASE", "OUTPUT"]
    assert error_count(validate_workflow(flow.nodes, flow.edges)) == 0

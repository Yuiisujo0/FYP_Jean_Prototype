

# ---------- Cloudflare Workers AI adapter (no network: parse_response is pure) ----------

def test_cloudflare_parse_response_reads_text_objects_and_usage():
    from app.cloudflare import parse_response

    content, stats = parse_response(200, {"success": True, "result": {"response": '{"steps":[]}', "usage": {"prompt_tokens": 700, "completion_tokens": 60}}})
    assert content == '{"steps":[]}' and stats["prompt_tokens"] == 700 and stats["eval_count"] == 60
    content, _ = parse_response(200, {"success": True, "result": {"response": {"steps": []}}})   # some models return an object
    assert content == '{"steps": []}'


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

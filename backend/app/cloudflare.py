"""Cloudflare Workers AI over its REST API, as an alternative to a local Ollama.

Credentials come from CF_ACCOUNT_ID and CF_API_TOKEN (environment variables, or backend/.env which is git-ignored).
Workers AI does not guarantee that output matches the schema ("JSON Mode couldn't be met"), so that case is reported
as a ModelOutputError and the generation loop retries it like any other bad answer.
"""
import json

import httpx

from . import config
from .errors import ModelOutputError, OllamaError

URL = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}"


def credentials_missing() -> str | None:
    if not config.CF_ACCOUNT_ID or not config.CF_API_TOKEN:
        return "Cloudflare credentials are missing. Set CF_ACCOUNT_ID and CF_API_TOKEN in backend/.env."
    return None


def parse_response(status: int, body: dict) -> tuple[str, dict]:
    """Turns a Workers AI reply into (content, stats), or raises. Pure, so it can be tested without a network."""
    errors = body.get("errors") or []
    detail = "; ".join(str(e.get("message", e)) if isinstance(e, dict) else str(e) for e in errors)
    if status == 429:
        raise OllamaError("Workers AI refused the request: the free daily allowance is used up, or requests are too frequent.")
    if status in (401, 403):
        raise OllamaError(f"Cloudflare rejected the credentials ({status}). Check CF_ACCOUNT_ID and CF_API_TOKEN. {detail}".strip())
    if "json mode" in detail.lower():
        raise ModelOutputError(detail)
    if status >= 400 or not body.get("success", False):
        raise OllamaError(f"Workers AI returned {status}: {detail or 'no details'}"[:400])

    result = body.get("result") or {}
    response = result.get("response")
    if response is None:
        # Newer models answer in the OpenAI chat shape: result.choices[0].message.content
        try:
            response = result["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            response = None
    if response is None:
        raise ModelOutputError("The model returned no content.")
    content = response if isinstance(response, str) else json.dumps(response)
    usage = result.get("usage") or {}
    return content, {
        "eval_count": usage.get("completion_tokens", 0),
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "neurons": float(usage.get("neurons") or 0.0),   # Cloudflare reports what each call cost against the free allowance
        "load_ms": 0, "prompt_ms": 0, "gen_ms": 0,       # not reported by Workers AI
    }


async def chat_json(model: str, messages: list[dict], schema: dict, temperature: float) -> tuple[str, dict]:
    problem = credentials_missing()
    if problem:
        raise OllamaError(problem)
    payload = {
        "messages": messages,
        "response_format": {"type": "json_schema", "json_schema": schema},
        "temperature": temperature,
        "max_tokens": 400,
    }
    try:
        async with httpx.AsyncClient(timeout=config.OLLAMA_TIMEOUT) as client:
            res = await client.post(
                URL.format(account=config.CF_ACCOUNT_ID, model=model),
                headers={"Authorization": f"Bearer {config.CF_API_TOKEN}"},
                json=payload,
            )
    except httpx.TimeoutException as e:
        raise OllamaError(f"Workers AI took longer than {config.OLLAMA_TIMEOUT:.0f}s to answer.") from e
    except httpx.HTTPError as e:
        raise OllamaError(f"Cannot reach Cloudflare. ({type(e).__name__})") from e
    try:
        body = res.json()
    except ValueError:
        raise OllamaError(f"Workers AI returned {res.status_code} with a body that is not JSON.") from None
    return parse_response(res.status_code, body if isinstance(body, dict) else {})

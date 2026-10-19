"""Checks the Cloudflare credentials and whether each candidate model accepts this project's JSON schema.

    python scripts/cf_check.py [--models @cf/meta/llama-3.1-8b-instruct,@cf/google/gemma-4-26b-a4b-it]

Reads CF_ACCOUNT_ID and CF_API_TOKEN from backend/.env or the environment. The values are never printed.
One small request per model, so it uses only a few neurons of the free daily allowance.
"""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import cloudflare, config  # noqa: E402
from app.errors import ModelOutputError, OllamaError  # noqa: E402
from app.schema import draft_json_schema  # noqa: E402

DEFAULT_MODELS = [
    "@cf/meta/llama-3.1-8b-instruct",
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/google/gemma-4-26b-a4b-it",
    "@cf/qwen/qwen3-30b-a3b-fp8",
    "@cf/openai/gpt-oss-20b",
]

MESSAGES = [
    {"role": "system", "content": 'Turn the request into a workflow. Answer with JSON {"steps": [...]}. Use only these operations: '
                                  "READ_CSV (file), FILTER (condition), OUTPUT (format). Start with READ_CSV and end with OUTPUT."},
    {"role": "user", "content": "Which items in the inventory dataset are below their reorder level?"},
]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(DEFAULT_MODELS))
    args = ap.parse_args()

    problem = cloudflare.credentials_missing()
    if problem:
        sys.exit(problem)
    print(f"credentials found (account id {len(config.CF_ACCOUNT_ID)} characters, token {len(config.CF_API_TOKEN)} characters; values not shown)\n")

    schema = draft_json_schema()
    for model in args.models.split(","):
        t0 = time.perf_counter()
        try:
            content, stats = await cloudflare.chat_json(model, MESSAGES, schema, 0.1)
            secs = time.perf_counter() - t0
            try:
                steps = [s.get("type") for s in json.loads(content)["steps"]]
                verdict = f"valid JSON, steps: {' > '.join(map(str, steps))}"
            except (ValueError, KeyError, TypeError, AttributeError):
                verdict = f"answered, but not the expected JSON: {content[:80]!r}"
            print(f"OK    {model}\n      {secs:.1f}s, {stats['prompt_tokens']} tokens in, {stats['eval_count']} out; {verdict}")
        except ModelOutputError as e:
            print(f"JSON  {model}\n      accepted the call but could not meet the schema: {e}")
        except OllamaError as e:
            print(f"FAIL  {model}\n      {e}")


if __name__ == "__main__":
    asyncio.run(main())

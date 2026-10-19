r"""Measure how well local models draft valid workflows, and how fast.

Run from the backend folder (with the venv active):
    python scripts/spike.py                                   # default model, all prompts
    python scripts/spike.py --models llama3.2:3b,gemma3:1b    # compare several models
    python scripts/spike.py --models phi4-mini --limit 3      # quick check

Per prompt it records: valid on the first attempt?, valid after repairs?, did the step types match the
expected sequence?, wall time, and tokens/second. Per model it also records how much of the model sits on the GPU.
Results are saved to eval/results-<model>.json, and a comparison table is printed at the end.
"""
import argparse
import asyncio
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config  # noqa: E402
from app.llm import OllamaError, generate_workflow, gpu_share, list_models  # noqa: E402


async def run_model(model: str, cases: list[dict], verbose: bool = True) -> dict:
    if verbose:
        print(f"\n=== {model} ===")
        print(f"{'id':<5}{'1st':<5}{'final':<7}{'tries':<7}{'match':<7}{'secs':<7}{'tok/s':<7} steps")
    rows = []
    for case in cases:
        try:
            r = await generate_workflow(case["prompt"], model)
        except OllamaError as e:
            print(f"{case['id']:<5}ERROR: {e}")
            rows.append({"id": case["id"], "error": str(e)})
            continue
        types = [n.type for n in r.flow.nodes]
        gen_ms = sum(a.gen_ms for a in r.attempts)
        tokens = sum(a.eval_tokens for a in r.attempts)
        tps = tokens / (gen_ms / 1000) if gen_ms else 0
        row = {
            "id": case["id"], "prompt": case["prompt"], "expected": case["expected"], "got": types,
            "first_try_valid": r.attempts[0].errors == 0, "final_valid": r.valid, "attempts": len(r.attempts),
            "type_match": types == case["expected"], "seconds": round(r.elapsed_ms / 1000, 1),
            "tokens_per_second": round(tps, 1), "output_tokens": tokens,
            "prompt_tokens": r.attempts[0].prompt_tokens,
            "first_attempt_seconds": round(r.attempts[0].ms / 1000, 1),
            "attempt_log": [a.__dict__ for a in r.attempts],
        }
        rows.append(row)
        if verbose:
            print(f"{case['id']:<5}{'y' if row['first_try_valid'] else 'n':<5}{'y' if row['final_valid'] else 'n':<7}{row['attempts']:<7}"
                  f"{'y' if row['type_match'] else 'n':<7}{row['seconds']:<7.1f}{row['tokens_per_second']:<7.1f}{' > '.join(types)}")

    done = [r for r in rows if "error" not in r]
    if not done:
        return {"model": model, "error": "no successful runs", "rows": rows}
    n = len(done)
    summary = {
        "model": model,
        "prompts": n,
        "gpu_share": await gpu_share(model),
        "first_try_valid_rate": round(sum(r["first_try_valid"] for r in done) / n, 2),
        "final_valid_rate": round(sum(r["final_valid"] for r in done) / n, 2),
        "type_match_rate": round(sum(r["type_match"] for r in done) / n, 2),
        "median_first_attempt_s": round(statistics.median(r["first_attempt_seconds"] for r in done), 1),
        "median_total_s": round(statistics.median(r["seconds"] for r in done), 1),
        "max_total_s": max(r["seconds"] for r in done),
        "tokens_per_second": round(statistics.median(r["tokens_per_second"] for r in done), 1),
        "median_output_tokens": int(statistics.median(r["output_tokens"] for r in done)),
        "prompt_tokens": done[0]["prompt_tokens"],
    }
    out = ROOT / "eval" / f"results-{model.replace(':', '_').replace('/', '_')}-ctx{config.NUM_CTX}.json"
    out.write_text(json.dumps({"summary": summary, "rows": rows}, indent=2), encoding="utf-8")
    return {"model": model, "summary": summary, "rows": rows}


def print_table(results: list[dict]) -> None:
    print("\n" + "=" * 100)
    print(f"{'model':<18}{'GPU':<6}{'1st-try':<9}{'final':<7}{'match':<7}{'1st call':<10}{'total med':<11}{'tok/s':<7}{'out tok':<8}")
    print("-" * 100)
    for r in results:
        s = r.get("summary")
        if not s:
            print(f"{r['model']:<18}{r.get('error', 'failed')}")
            continue
        gpu = f"{int((s['gpu_share'] or 0) * 100)}%" if s["gpu_share"] is not None else "?"
        print(f"{s['model']:<18}{gpu:<6}{int(s['first_try_valid_rate'] * 100):>3}%     {int(s['final_valid_rate'] * 100):>3}%   "
              f"{int(s['type_match_rate'] * 100):>3}%   {s['median_first_attempt_s']:<10}{s['median_total_s']:<11}{s['tokens_per_second']:<7}{s['median_output_tokens']:<8}")
    print("=" * 100)
    print("GPU = share of the model held in VRAM (100% is fastest). 1st call = median seconds for one model call.")


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", default=config.OLLAMA_MODEL, help="comma-separated model names")
    parser.add_argument("--limit", type=int, default=0, help="only run the first N prompts")
    parser.add_argument("--prompts", default=str(ROOT / "eval" / "prompts.json"))
    args = parser.parse_args()

    try:
        installed = await list_models()
    except OllamaError as e:
        print(f"FAIL: {e}")
        return 1
    print(f"Ollama OK at {config.OLLAMA_URL}. Installed: {', '.join(installed) or 'none'}")
    print(f"num_ctx={config.NUM_CTX} | max repairs={config.MAX_REPAIRS}")

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    missing = [m for m in models if m not in installed]
    if missing:
        print(f"Skipping (not installed): {', '.join(missing)}  ->  ollama pull <name>")
        models = [m for m in models if m in installed]
    if not models:
        return 1

    cases = json.loads(Path(args.prompts).read_text(encoding="utf-8"))
    if args.limit:
        cases = cases[: args.limit]

    results = [await run_model(m, cases) for m in models]
    print_table(results)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

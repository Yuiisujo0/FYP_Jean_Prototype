# JWork backend

FastAPI service that turns a natural-language request into a validated workflow using a **local** Ollama model.
No cloud API is involved.

## Run it

```powershell
cd backend
py -3.13 -m venv .venv                      # once
.venv\Scripts\python -m pip install -r requirements-dev.txt   # once
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

Interactive docs: http://localhost:8000/docs

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Server is up |
| `GET /api/model/status` | Ollama reachable? Is the configured model installed? |
| `POST /api/generate` | `{ "prompt": "..." }` -> workflow, validation issues, retrieved patterns, attempt log |
| `POST /api/validate` | Run the validator on a `{nodes, edges}` payload |
| `POST /api/refine` | `{ "steps": [{type, config}], "instruction": "..." }` -> the whole workflow after the change, and whether anything changed |

The `/api/datasets` endpoints are no longer used by the frontend (datasets now live in the browser, see `src/lib/library.ts`). They stay as the reference for the browser reader: `tests/tables.test.ts` checks that both read files identically.

## Configuration (environment variables)

`OLLAMA_URL` (default `http://localhost:11434`), `OLLAMA_MODEL` (default `qwen2.5:7b`; `gemma3:4b` and `qwen3:4b` also work),
`NUM_CTX` (2048), `OLLAMA_TIMEOUT` (180), `MAX_REPAIRS` (2).

## Measure a model

```powershell
.venv\Scripts\python scripts\spike.py                         # all prompts in eval/prompts.json
.venv\Scripts\python scripts\spike.py --model qwen3:1.7b      # after: ollama pull qwen3:1.7b
```

Writes `eval/results-<model>.json`. Add prompts to `eval/prompts.json`
(keep them different from the worked example in `app/llm.py`, otherwise you measure memorisation).

## Model comparison (GTX 1650 4 GB, 15 GB RAM, 10 prompts in `eval/prompts.json`)

| Model | on GPU | 1st-try valid | valid after repair | right steps | median total | tok/s |
|---|---|---|---|---|---|---|
| gemma3:4b | 46% | 90% | 100% | 80% | 6.9 s | 17 |
| qwen3:4b | 73% | 60% | 100% | 80% | 5.7 s | 25 |
| phi4-mini | 70% | 50% | 90% | 70% | 4.5 s | 29 |
| llama3.2:3b | 85% | 100% | 100% | 50% | 2.7 s | 54 |
| llama3.2:1b | 100% | 30% | 90% | 20% | 2.3 s | 88 |
| granite3.3:2b | 100% | 90% | 100% | 20% | 2.2 s | 72 |
| smollm2:1.7b | 88% | 30% | 80% | 20% | 3.5 s | 55 |
| gemma3:1b | 100% | 50% | 60% | 0% | 2.7 s | 97 |

"Right steps" = the exact expected sequence of operations (a strict test). Models under ~3B are fast but pick the wrong
steps; 4B models are accurate but about half of each runs on the CPU because of the 4 GB of VRAM.
The biggest speed-up was not the model: asking it for step types and parameters only (about 50-90 output tokens
instead of about 220) roughly halved latency for every model.

## Tests

```powershell
.venv\Scripts\python -m pytest -q
```

## How generation works

1. `retrieval.py` picks the most relevant reference patterns.
2. `llm.py` sends the catalogue of allowed operations + patterns + one worked example to Ollama,
   with a JSON Schema in which the step `type` is an **enum**, so unsupported operations cannot be emitted.
3. `validate.py` checks the draft. On errors the problems are sent back and the model retries
   (hotter each time, up to `MAX_REPAIRS`).
4. The server assigns ids, edges and positions and returns a `Flow` the React app already understands.

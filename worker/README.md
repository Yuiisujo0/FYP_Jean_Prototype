# jwork-ai: the generation Worker

A small Cloudflare Worker that turns a plain-English request into a validated workflow using Workers AI. It exists so the
public site can generate workflows **without any API token in the app or in a browser**: the Worker reaches the models
through the `AI` binding, which Cloudflare provides inside its own network.

It runs the same pipeline as the Python backend (retrieve examples, prompt, schema-constrained model call, validate, repair).
`tests/pipeline.test.ts` proves the TypeScript pipeline produces byte-identical prompts and workflows to the Python reference.

| | |
|---|---|
| `POST /api/generate` | body `{ "prompt": "...", "datasets": [{ "name": "marks", "columns": ["name", "score"] }] }` (datasets optional; names and columns only, never rows) |
| `POST /api/refine` | body `{ "steps": [{ "type": "FILTER", "config": { "condition": "score < 50" } }], "instruction": "Change the limit to 40", "datasets": [...] }`; returns the whole workflow after the change and whether anything changed. Only the steps and the instruction are used, never data |
| `GET /api/health` | `{ "status": "ok", "provider": "workers-ai", "models": [...] }` |

The response has the same shape as the Python backend's `/api/generate`, so the frontend works with either.

**What it does not do:** it has no data library and runs no workflows. Uploaded datasets and the engine live in the browser or
the Python backend. On a public site the data library has to move into the browser (still to be built).

## Deploy (about five minutes, free plan)

You need the Cloudflare account you already created. Nothing here uses the API token you made earlier.

1. In a terminal: `cd worker`
2. `npx wrangler login` and click **Allow** in the browser tab that opens.
3. Open `wrangler.toml` and change the first item of `ALLOWED_ORIGINS` to the address of your GitHub Pages site
   (it is `https://<your-github-name>.github.io`, with no path). Keep the localhost entries for development.
4. `npx wrangler deploy`. It prints an address like `https://jwork-ai.<your-subdomain>.workers.dev`.
5. Check it:
   ```
   curl https://jwork-ai.<your-subdomain>.workers.dev/api/health
   curl -X POST https://jwork-ai.<your-subdomain>.workers.dev/api/generate -H "Content-Type: application/json" -d "{\"prompt\":\"Show employees in Sales earning over 6000\"}"
   ```
6. Use it from the app: start the frontend with `VITE_API_URL` set to that address (PowerShell:
   `$env:VITE_API_URL="https://jwork-ai.<your-subdomain>.workers.dev"; npm run dev`). Generate works; the Data tab will say the
   data library is unavailable, because the Worker does not store data.

Useful: `npx wrangler tail` shows live logs. To switch generation off in an emergency, uncomment `AI_ENABLED = "false"`
in `wrangler.toml` and run `npx wrangler deploy` again.

## Models and the free allowance

`MODELS` is tried in order: the first that can answer wins; if it is down or out of quota the next one is used. If none can,
the caller gets a clear 503 saying the editor still works. Measured cost of one generation (about 740-token prompt):
gpt-oss-20b about 21 neurons, llama-3.1-8b about 5. The free allowance is 10,000 neurons a day, shared by every visitor and
by your own testing, and it resets at 00:00 UTC (08:00 in Malaysia). When it is used up, calls fail; the free plan never bills.

## Safety notes (honest limits)

- The `Origin` check only stops other **websites** from calling the Worker from a browser. It is not authentication: anyone can
  call the address directly. The protections that matter are the free plan's hard daily cap, the 500-character prompt limit,
  the 20 KB request limit, and the rate limit.
- The rate limit (`MAX_REQUESTS_PER_MINUTE`, default 10 per client) is kept in memory per Cloudflare isolate, so it is
  approximate. For a stronger limit use Cloudflare's rate limiting rules in the dashboard, or Turnstile.
- Errors from the AI service are never repeated to the caller; details go to the Worker's own log.

## Keeping it in step with Python

The Python backend is the reference. After changing a prompt, an operation, the pattern library or the syntax hints:

```
backend\.venv\Scripts\python backend\scripts\export_contract.py   # regenerates src/pipeline/contract.ts and backend/eval/golden.json
npm run test:pipeline                                              # fails if the TypeScript port no longer matches
```

Tests: `npm run test:pipeline` (parity and generation loop), `npm run test:worker` (HTTP layer).
Live check against the real Workers AI (costs about 300 neurons): `node tests/worker-live.ts dev 600`.

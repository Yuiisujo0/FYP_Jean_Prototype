# jwork

Spreadsheet answers you can check before you send them on.

You describe the list or total you need in plain words. An AI model writes the steps, a normal program runs them on your
table in the browser, and you see every row that was kept, left out or could not be judged. You approve the result and
download an Excel report that records what was done.

**Live site:** https://yuiisujo0.github.io/FYP_Jean_Prototype/

This is a Final Year Project prototype (Universiti Malaysia Sarawak). It is a research tool, not a finished product.

## Try it

1. Open the live site and go to **Generate**.
2. Click **Add sample data**. It adds four small made-up tables (library loans, employees, sales orders, inventory) to
   the Data library in your browser.
3. Pick an example, such as *From employees, list everyone in Sales earning over 6000, highest salary first*, and click
   **Build workflow**.
4. The workflow opens on its result:
   1. **The answer:** the rows, with a count of how many were read, kept, left out and flagged.
   2. **What the AI understood:** the steps in plain words. If they are not what you meant, type a change.
   3. **What needs your eye:** rows that could not be checked, and assumptions to confirm.
   4. **Approve and download:** the Excel report (Result, Review and Method sheets, with fingerprints of the data).

   **How it was done** shows the same steps as a diagram you can edit.

To use your own data, upload a CSV or Excel file on **Knowledge base > Data**.

## Where your data goes

- Your rows stay in your browser (IndexedDB). They are never uploaded.
- The AI sees your request, the dataset and column names, row counts and the step settings, never cell values.
- With the free hosted model, that request text and those column names go to Cloudflare. With Ollama they stay on your
  computer.

## Choosing the AI model

**Settings > AI model** offers three options:

| Option | What it is | Set-up |
|---|---|---|
| Free hosted model | gpt-oss-20b on Cloudflare Workers AI, through the Worker in `worker/` | None. A shared daily allowance applies |
| Ollama on this computer | A model on your own machine, called straight from the browser (tested in Chrome) | Install Ollama, then allow the site: `setx OLLAMA_ORIGINS "https://yuiisujo0.github.io"`, then quit and restart Ollama |
| My own API key | Any OpenAI-compatible service | Paste the key. It stays in your browser |

## How it works

1. **Plan.** The model picks steps from a fixed list of operations (read a dataset, filter, select, sort, limit, group and
   summarise, remove duplicates, join, save a table, call a web address, output). It cannot write code.
2. **Test.** A checking agent dry-runs the plan on your data and compares it with your request: a value you named that
   the filter does not use, a column that does not exist, a "not" that was dropped, a missing sort or join, and more.
   Rules fix what they can; the model is asked for the rest, at most twice.
3. **Run and review.** The engine records the fate of every source row, so the totals must add up. Blank or unreadable
   values are flagged instead of silently dropped.
4. **Approve.** Approval is blocked until each critical exception is accepted with a reason and each assumption is confirmed.

## Run it locally

You need Node.js 24.

```bash
npm ci
npm run dev        # http://localhost:5173/FYP_Jean_Prototype/
```

Generation needs one of the three AI options. To use the hosted Worker from a local copy:

```bash
VITE_API_URL=https://jwork-ai.jwork-fyp.workers.dev npm run dev
```

There is also a Python reference backend with Ollama (`backend/`, see `backend/README.md`). `npm run dev:all` starts it
together with the site.

## Tests

```bash
npm test               # all unit tests
npm run test:public    # the tests that need no private data (what GitHub runs before each deploy)
npm run build
```

Browser tests are in `tests/e2e-*.mjs` and use Playwright with Edge. `tests/e2e-result.mjs` walks through a first visit.

The evaluation tasks and model runs (`backend/eval/`) are kept private, because two of the test sets have not been used
yet and must stay unseen until the final measurement. The unit tests that read them run only on the development machine.

## Repository layout

| Path | Contents |
|---|---|
| `src/lib/` | The engine (`engine.ts`), the checking agent (`agent.ts`, `grounding.ts`, `repair.ts`), review and approval (`review.ts`), the Excel report (`xlsx.ts`) |
| `src/pipeline/` | Prompt, generation and repair, a TypeScript port of the Python reference, kept identical by tests |
| `src/features/editor/` | The Result view and the step editor |
| `worker/` | The Cloudflare Worker behind the free hosted model (see `worker/README.md`) |
| `backend/` | The Python reference backend and evaluation scripts |
| `tests/` | Unit tests (`*.test.ts`), browser tests (`e2e-*.mjs`) and evaluation scripts |

## Deploying

Every push to `main` runs the public tests and the build, then publishes the site to GitHub Pages
(`.github/workflows/deploy.yml`). A failing test stops the deploy. The Worker is deployed by hand: `cd worker`, then
`npx wrangler deploy`.

// Runs the unit tests that need no private data, for the deploy on GitHub. backend/eval/ is git-ignored (it holds the
// unspent holdout tasks), so test files that read it can only run on this laptop: they are listed and skipped here.
// Locally, `node --test tests/*.test.ts` still runs everything.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('tests').filter(f => f.endsWith('.test.ts')).map(f => `tests/${f}`).sort();
const isPrivate = f => /backend\/eval\//.test(readFileSync(f, 'utf-8').replace(/^\s*\/\/.*$/gm, ''));
const skipped = files.filter(isPrivate);
const run = files.filter(f => !isPrivate(f));

console.log(`Running ${run.length} test files. Skipped (need the private backend/eval/): ${skipped.join(', ') || 'none'}`);
const result = spawnSync(process.execPath, ['--test', ...run], { stdio: 'inherit' });
process.exit(result.status ?? 1);

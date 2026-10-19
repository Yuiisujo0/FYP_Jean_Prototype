// One command to start everything: `npm run dev:all`.
// If a backend is already answering on port 8000 it is reused instead of starting a second one
// (starting a second one is what causes "only one usage of each socket address").
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const python = join(root, 'backend', '.venv', 'Scripts', 'python.exe');
const children = [];

function run(label, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, env: process.env });
  const pipe = stream => stream.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => console.log(`[${label}] ${l}`)));
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', code => console.log(`[${label}] stopped (exit ${code})`));
  children.push(child);
}

const backendUp = await fetch('http://127.0.0.1:8000/api/health', { signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false);

if (backendUp) {
  console.log('[dev] Backend already running on port 8000, reusing it. (Stop it first if you want it to reload your backend changes.)');
} else if (!existsSync(python)) {
  console.log('[dev] backend/.venv not found. Create it first, see backend/README.md. Starting the frontend only.');
} else {
  run('backend', python, ['-m', 'uvicorn', 'app.main:app', '--reload', '--reload-dir', 'app', '--port', '8000'], join(root, 'backend'));
}

run('frontend', process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js')], root);

const stop = () => { children.forEach(c => c.kill()); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

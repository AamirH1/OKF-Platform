#!/usr/bin/env node
// Local development: apply migrations, then run API, worker and web with prefixed output.
// Requires `docker compose up -d` (Postgres, Redis, MinIO, Mailpit) and a `.env` file.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (!existsSync(path.join(root, '.env'))) {
  copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'));
  console.log('Created .env from .env.example');
}

const migrate = spawnSync('npm', ['run', 'migrate', '-w', '@okf/db'], { cwd: root, stdio: 'inherit' });
if (migrate.status !== 0) {
  console.error('\nMigrations failed. Is Postgres running? Try: docker compose up -d');
  process.exit(migrate.status ?? 1);
}

const colors = { api: '\x1b[36m', worker: '\x1b[35m', web: '\x1b[32m' };
const procs = [
  ['api', ['run', 'dev', '-w', '@okf/api']],
  ['worker', ['run', 'dev', '-w', '@okf/worker']],
  ['web', ['run', 'dev', '-w', '@okf/web']],
].map(([name, args]) => {
  const child = spawn('npm', args, { cwd: root, env: { ...process.env, FORCE_COLOR: '1' } });
  const prefix = `${colors[name]}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown();
  });
  return child;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log('\nOKF Platform: web http://localhost:3000 · API http://localhost:4000 · MinIO console http://localhost:9001 · Mailpit http://localhost:8025\n');

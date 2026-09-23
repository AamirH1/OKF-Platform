#!/usr/bin/env node
// Generate a large, realistic, OKF-conformant bundle for load and performance testing.
//   node scripts/generate-large-fixture.mjs [concepts=5000] [--tar]
// Output: tests/fixtures/okf/generated/large-<n>/ (git-ignored), optionally .tar.gz.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = ['BigQuery Table', 'Metric', 'Playbook', 'API Endpoint', 'Reference'];
const DIRS = { 'BigQuery Table': 'tables', Metric: 'metrics', Playbook: 'playbooks', 'API Endpoint': 'apis', Reference: 'references' };
const COLUMN_TYPES = ['STRING', 'INT64', 'NUMERIC(18,2)', 'TIMESTAMP', 'BOOL', 'DATE', 'ARRAY<STRING>'];

/** Deterministic PRNG so generated bundles are reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function generateBundle(dir, n) {
  const rand = rng(n);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  rmSync(dir, { recursive: true, force: true });
  const concepts = Array.from({ length: n }, (_, i) => {
    const type = TYPES[i % TYPES.length];
    return { i, type, dir: DIRS[type], slug: `${DIRS[type].slice(0, -1)}-${String(i).padStart(6, '0')}` };
  });
  const byDir = new Map();
  for (const c of concepts) {
    const links = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(concepts));
    const verified = rand() < 0.6 ? `verified:\n  - { by: ${rand() < 0.5 ? 'human:reviewer' : 'process:nightly'}, at: 2026-08-0${1 + (c.i % 9)}T00:00:00Z }\n` : '';
    const cols = c.type === 'BigQuery Table' ? Array.from({ length: 5 + Math.floor(rand() * 20) }, (_, k) => `| \`col_${k}_${c.i}\` | ${pick(COLUMN_TYPES)} | Column ${k} of table ${c.i}. |`) : [];
    const body = [
      cols.length ? `# Schema\n\n| Column | Type | Description |\n|---|---|---|\n${cols.join('\n')}\n` : '# Definition\n\nGenerated concept used for load testing the OKF platform.\n',
      `# Related\n\n${links.map((l) => `- See [${l.slug}](/${l.dir}/${l.slug}.md).`).join('\n')}\n`,
      rand() < 0.02 ? '- A [broken link](/missing/nowhere.md) (tolerated per OKF §6.1).\n' : '',
    ].join('\n');
    const fm = [
      `type: ${c.type}`,
      `title: ${c.type} ${c.i}`,
      `description: Synthetic ${c.type.toLowerCase()} number ${c.i} for performance testing.`,
      `tags: [load-test, ${c.dir}, shard-${c.i % 17}]`,
      `generated: { by: generator/1.0, at: 2026-07-01T00:00:00Z }`,
      verified.trimEnd(),
      rand() < 0.1 ? 'stale_after: 2026-01-01T00:00:00Z' : 'stale_after: 2099-01-01T00:00:00Z',
      `sources:\n  - id: src-${c.i}\n    resource: https://example.com/docs/${c.i}\n    usage_count: ${Math.floor(rand() * 1000)}`,
    ].filter(Boolean);
    const file = path.join(dir, c.dir, `${c.slug}.md`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `---\n${fm.join('\n')}\n---\n\n${body}`);
    byDir.set(c.dir, [...(byDir.get(c.dir) ?? []), c]);
  }
  for (const [d, items] of byDir) {
    writeFileSync(path.join(dir, d, 'index.md'), `# ${items[0].type}\n\n${items.map((c) => `* [${c.type} ${c.i}](${c.slug}.md) - Synthetic ${c.type.toLowerCase()} ${c.i}.`).join('\n')}\n`);
  }
  writeFileSync(path.join(dir, 'index.md'), `---\nokf_version: "0.2"\n---\n\n# Directories\n\n${[...byDir.keys()].map((d) => `* [${d}](${d}/index.md) - ${byDir.get(d).length} concepts.`).join('\n')}\n`);
  writeFileSync(path.join(dir, 'log.md'), '# Bundle history\n\n## 2026-07-01\n* **Creation**: Generated for load testing.\n');
  return dir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const n = Number(process.argv[2] ?? 5000);
  const root = path.resolve(import.meta.dirname, '../tests/fixtures/okf/generated');
  const dir = generateBundle(path.join(root, `large-${n}`), n);
  console.log(`generated ${n} concepts in ${dir}`);
  if (process.argv.includes('--tar')) {
    const { create } = await import('tar');
    const file = `${dir}.tar.gz`;
    await create({ gzip: true, file, cwd: root }, [path.basename(dir)]);
    console.log(`archive ${file}`);
  }
}

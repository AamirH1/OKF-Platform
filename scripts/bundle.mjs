#!/usr/bin/env node
// Bundle a Node service (API or worker) into one ESM file. Workspace packages (TypeScript
// source) are inlined; npm dependencies stay external and are installed in the image.
// Usage: node scripts/bundle.mjs <entry.ts> <out.js>   (run from the app directory)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: bundle.mjs <entry> <outfile>');
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
// Every non-workspace package is external.
const external = Object.keys(lock.packages)
  .filter((p) => p.startsWith('node_modules/') && !lock.packages[p].link)
  .map((p) => p.replace(/^.*node_modules\//, ''))
  .filter((n) => !n.startsWith('@okf/'));

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: [...new Set(external)],
  // ESM output needs require() for any CJS dependency that does dynamic requires.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

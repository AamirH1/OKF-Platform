import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations
import { generateBundle } from '../../../scripts/generate-large-fixture.mjs';
import { analyzeBundle, DirectorySource } from '../src';

/**
 * Measures the engine on a large generated bundle and guards against pathological
 * slowdowns (e.g. accidental O(n²) link resolution). The bound is deliberately generous;
 * the measured time is printed so regressions are visible in CI logs.
 */
describe('analyzeBundle performance', () => {
  let dir: string;
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('analyzes 5,000 concepts well within budget', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'okf-perf-'));
    const bundle = (generateBundle as (d: string, n: number) => string)(path.join(dir, 'large'), 5000);
    const started = performance.now();
    const r = await analyzeBundle(new DirectorySource(bundle), { now: new Date('2026-09-23T00:00:00Z') });
    const ms = Math.round(performance.now() - started);
    console.log(`analyzeBundle(5000 concepts): ${ms} ms, ${r.files.length} files, ${r.profile.links.total} links, ${r.issues.length} issues`);
    expect(r.validation.valid).toBe(true);
    expect(r.concepts).toHaveLength(5000);
    expect(r.profile.assetSchemas.conceptsWithSchema).toBe(1000);
    expect(ms).toBeLessThan(60_000);
  }, 120_000);
});

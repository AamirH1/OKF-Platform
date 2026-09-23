import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations
import { generateBundle } from '../../../../scripts/generate-large-fixture.mjs';
import { createHarness, TestClient, type TestHarness, uploadFile } from '../../../../tests/setup/app';

/**
 * Opt-in load measurement of the full ingestion pipeline (OKF_PERF=1 npm run test:integration).
 * Prints per-stage timings; asserts only generous bounds.
 */
describe.runIf(process.env.OKF_PERF === '1')('ingestion performance', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createHarness();
    await h.reset();
  });
  afterAll(() => h.close());

  it('ingests and queries a 5,000-concept bundle', async () => {
    const n = Number(process.env.OKF_PERF_CONCEPTS ?? 5000);
    const dir = (generateBundle as (d: string, n: number) => string)(path.join(h.tmp, 'gen', `large-${n}`), n);
    const { create } = await import('tar');
    const archive = path.join(h.tmp, 'large.tar.gz');
    await create({ gzip: true, file: archive, cwd: path.dirname(dir) }, [path.basename(dir)]);
    const c = new TestClient(h.app);
    await c.signup('perf@example.com');
    const org = (await c.post('/api/v1/organizations', { name: 'Perf' })).json();
    const ds = (await c.post('/api/v1/datasets', { organizationId: org.id, name: 'Large' })).json();

    let t = performance.now();
    await uploadFile(c, ds.id, archive);
    const upload = performance.now() - t;
    t = performance.now();
    await h.drainJobs();
    const ingest = performance.now() - t;
    const v = (await c.get(`/api/v1/datasets/${ds.id}`)).json().latestVersion;
    t = performance.now();
    const preview = await c.get(`/api/v1/datasets/${ds.id}/preview?page=40&pageSize=50&sort=title`);
    const previewMs = performance.now() - t;
    t = performance.now();
    const q1 = await c.post(`/api/v1/datasets/${ds.id}/query/sql`, { sql: 'SELECT type, count(*) n, avg(link_count) FROM concepts GROUP BY type' });
    const coldQuery = performance.now() - t;
    t = performance.now();
    await c.post(`/api/v1/datasets/${ds.id}/query/sql`, { sql: "SELECT count(*) FROM schema_columns WHERE data_type = 'STRING'" });
    const warmQuery = performance.now() - t;
    t = performance.now();
    const search = await c.get('/api/v1/search?scope=concepts&q=synthetic%20metric');
    const searchMs = performance.now() - t;

    const job = (await c.get(`/api/v1/jobs/${v.job.id}`)).json();
    console.log(
      JSON.stringify({ concepts: n, archiveBytes: v.archiveSize, uploadMs: Math.round(upload), ingestMs: Math.round(ingest), previewMs: Math.round(previewMs), coldQueryMs: Math.round(coldQuery), warmQueryMs: Math.round(warmQuery), searchMs: Math.round(searchMs), jobResult: job.result }),
    );
    expect(v).toMatchObject({ status: 'VALIDATED', conceptCount: n });
    expect(preview.statusCode).toBe(200);
    expect(q1.json().rows).toHaveLength(5);
    expect(search.json().page.total).toBeGreaterThan(0);
    expect(ingest).toBeLessThan(300_000);
  }, 600_000);
});

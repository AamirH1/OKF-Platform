import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, FIXTURES, packFixture, TestClient, type TestHarness, uploadFile } from '../../../../tests/setup/app';

/**
 * The brief's acceptance flow, end to end through HTTP, real object storage (presigned
 * multipart PUTs to MinIO), the real worker pipeline, Postgres and DuckDB.
 */
describe('dataset lifecycle (acceptance criteria)', () => {
  let h: TestHarness;
  let alice: TestClient;
  let orgId: string;
  let datasetId: string;

  beforeAll(async () => {
    h = await createHarness();
    await h.reset();
    alice = new TestClient(h.app);
  });
  afterAll(() => h.close());

  it('signs up, creates an organization, logs in again', async () => {
    await alice.signup('alice@example.com', 'Alice');
    const org = await alice.post('/api/v1/organizations', { name: 'Northwind Analytics' });
    expect(org.statusCode).toBe(201);
    orgId = org.json().id;
    expect(org.json()).toMatchObject({ slug: 'northwind-analytics', role: 'owner', memberCount: 1 });

    await alice.post('/api/v1/auth/logout');
    expect((await alice.get('/api/v1/users/me')).statusCode).toBe(401);
    const login = await alice.post('/api/v1/auth/login', { email: 'ALICE@example.com', password: 'correct horse battery staple' });
    expect(login.statusCode).toBe(200);
    expect(login.json().organizations).toEqual([expect.objectContaining({ id: orgId, role: 'owner' })]);
  });

  it('creates a dataset and uploads a valid OKF bundle; the background job validates it', async () => {
    const ds = await alice.post('/api/v1/datasets', { organizationId: orgId, name: 'Northwind Warehouse', description: 'Sales knowledge', tags: ['sales', 'Warehouse'] });
    expect(ds.statusCode).toBe(201);
    datasetId = ds.json().id;
    expect(ds.json()).toMatchObject({ status: 'DRAFT', tags: ['sales', 'warehouse'], latestVersion: null });

    const version = await uploadFile(alice, datasetId, await packFixture(h.tmp, 'valid-minimal'));
    expect(version).toMatchObject({ number: 1, status: 'PROCESSING', job: { status: 'QUEUED' } });
    expect((await alice.get(`/api/v1/datasets/${datasetId}`)).json().status).toBe('PROCESSING');

    expect(await h.drainJobs()).toBe(1);
    const job = await alice.get(`/api/v1/jobs/${version.job.id}`);
    expect(job.json()).toMatchObject({ status: 'COMPLETED', progress: 100, stage: 'done' });

    const d = (await alice.get(`/api/v1/datasets/${datasetId}`)).json();
    expect(d.status).toBe('VALIDATED');
    expect(d.latestVersion).toMatchObject({ number: 1, status: 'VALIDATED', valid: true, conceptCount: 4, fileCount: 9, errorCount: 0, okfVersion: '0.2', format: 'tar.gz', scanStatus: 'skipped' });
    expect(d.latestVersion.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.permissions).toContain('dataset:publish');
  });

  it('exposes schema, metadata, validation, preview, concept detail, graph and files', async () => {
    const schema = (await alice.get(`/api/v1/datasets/${datasetId}/schema`)).json();
    expect(schema.fields.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['type', 'title', 'owner_team']));
    const orders = schema.assetSchemas.find((s: { conceptId: string }) => s.conceptId === 'tables/orders');
    expect(orders.columns.map((c: { name: string }) => c.name)).toEqual(['order_id', 'customer_id', 'order_total', 'placed_at', 'shipped_at']);
    expect(orders.columns[2].dataType).toBe('NUMERIC(12,2)');

    const meta = (await alice.get(`/api/v1/datasets/${datasetId}/metadata`)).json();
    expect(meta.profile.trustTiers).toEqual({ unverified: 2, 'machine-confirmed': 1, 'human-reviewed': 1 });

    const validation = (await alice.get(`/api/v1/datasets/${datasetId}/validation`)).json();
    expect(validation).toMatchObject({ valid: true, specVersion: '0.2', counts: { errors: 0 } });

    const preview = (await alice.get(`/api/v1/datasets/${datasetId}/preview?pageSize=2&sort=title`)).json();
    expect(preview.rowCount).toBe(4);
    expect(preview.rows.page.total).toBe(4);
    expect(preview.rows.data.map((r: { title: string }) => r.title)).toEqual(['Customers', 'Incident response: late shipments']);
    const typeCol = preview.columns.find((c: { name: string }) => c.name === 'type');
    expect(typeCol).toMatchObject({ nullPct: 0, distinctCount: 3 });

    const concept = (await alice.get(`/api/v1/datasets/${datasetId}/concepts/tables/orders`)).json();
    expect(concept.body).toContain('# Schema');
    expect(concept.inbound.map((i: { sourceConceptId: string }) => i.sourceConceptId)).toEqual(expect.arrayContaining(['tables/customers', 'metrics/revenue']));
    expect(concept.frontmatter.owner_team).toBe('sales-analytics');

    const graph = (await alice.get(`/api/v1/datasets/${datasetId}/graph`)).json();
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toContainEqual({ source: 'tables/orders', target: 'tables/customers' });

    const files = (await alice.get(`/api/v1/datasets/${datasetId}/files`)).json();
    expect(files.page.total).toBe(9);
  });

  it('queries with the structured builder and read-only SQL (DuckDB)', async () => {
    const q = await alice.post(`/api/v1/datasets/${datasetId}/query`, {
      table: 'concepts',
      columns: ['concept_id', 'trust_tier'],
      filters: [{ column: 'type', op: 'eq', value: 'BigQuery Table' }],
      sort: [{ column: 'concept_id', direction: 'asc' }],
    });
    expect(q.statusCode).toBe(200);
    expect(q.json().rows).toEqual([
      { concept_id: 'tables/customers', trust_tier: 'machine-confirmed' },
      { concept_id: 'tables/orders', trust_tier: 'human-reviewed' },
    ]);
    const sql = await alice.post(`/api/v1/datasets/${datasetId}/query/sql`, { sql: 'SELECT name, data_type FROM schema_columns WHERE concept_id = \'tables/customers\' ORDER BY ordinal' });
    expect(sql.json().rows[0]).toEqual({ name: 'customer_id', data_type: 'STRING' });
    const bad = await alice.post(`/api/v1/datasets/${datasetId}/query/sql`, { sql: 'DELETE FROM concepts' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('QUERY_FORBIDDEN_STATEMENT');
  });

  it('finds the dataset and its concepts in catalog search (members)', async () => {
    const byColumn = (await alice.get('/api/v1/search?q=shipped_at')).json();
    expect(byColumn.data.map((h: { dataset: { id: string } }) => h.dataset.id)).toContain(datasetId);
    const concepts = (await alice.get('/api/v1/search?scope=concepts&q=customers')).json();
    expect(concepts.data[0]).toMatchObject({ kind: 'concept', concept: { conceptId: 'tables/customers' } });
    const byTag = (await alice.get('/api/v1/datasets?tag=warehouse')).json();
    expect(byTag.page.total).toBe(1);
  });

  it('creates a second version and compares versions (exact vs statistical)', async () => {
    const dir = path.join(h.tmp, 'v2', 'valid-minimal');
    await mkdir(path.dirname(dir), { recursive: true });
    await cp(path.join(FIXTURES, 'valid-minimal'), dir, { recursive: true });
    await writeFile(
      path.join(dir, 'tables/returns.md'),
      '---\ntype: BigQuery Table\ntitle: Returns\ndescription: Returned orders.\n---\n\n# Schema\n\n| Column | Type |\n|---|---|\n| `order_id` | STRING |\n',
    );
    const { create } = await import('tar');
    const archive = path.join(h.tmp, 'v2.tar.gz');
    await create({ gzip: true, file: archive, cwd: path.dirname(dir) }, ['valid-minimal']);
    const v2 = await uploadFile(alice, datasetId, archive);
    expect(v2.number).toBe(2);
    await h.drainJobs();

    const first = await alice.get(`/api/v1/datasets/${datasetId}/diff?base=1&target=2`);
    expect(first.statusCode).toBe(202);
    await h.drainJobs();
    const diff = await alice.get(`/api/v1/datasets/${datasetId}/diff?base=1&target=2`);
    expect(diff.statusCode).toBe(200);
    const d = diff.json().diff;
    expect(d.exact.concepts.added).toEqual([{ id: 'tables/returns', type: 'BigQuery Table', title: 'Returns' }]);
    expect(d.exact.assetSchemas).toEqual([expect.objectContaining({ conceptId: 'tables/returns', status: 'added' })]);
    expect(d.statistical.conceptCount).toEqual({ before: 4, after: 5, delta: 1 });
    expect(d.summary.breaking).toBe(false);

    const versions = (await alice.get(`/api/v1/datasets/${datasetId}/versions`)).json();
    expect(versions.data.map((v: { number: number }) => v.number)).toEqual([2, 1]);
  });

  it('publishes; another user and anonymous visitors can read it once public', async () => {
    const bob = new TestClient(h.app);
    await bob.signup('bob@example.com', 'Bob');
    // Organization-only: invisible to non-members, including via search.
    expect((await bob.get(`/api/v1/datasets/${datasetId}`)).statusCode).toBe(404);

    const pub = await alice.post(`/api/v1/datasets/${datasetId}/publish`, {});
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ status: 'PUBLISHED', publishedVersion: { number: 2, status: 'PUBLISHED' } });
    expect((await bob.get(`/api/v1/datasets/${datasetId}`)).statusCode).toBe(404);

    const vis = await alice.put(`/api/v1/datasets/${datasetId}/visibility`, { visibility: 'public' });
    expect(vis.statusCode).toBe(200);

    const seen = await bob.get(`/api/v1/datasets/${datasetId}`);
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({ access: 'public', latestVersion: null, publishedVersion: { number: 2 } });
    expect(seen.json().permissions).not.toContain('dataset:update');
    // Public viewers see only the published version.
    expect((await bob.get(`/api/v1/datasets/${datasetId}/versions`)).json().data.map((v: { number: number }) => v.number)).toEqual([2]);
    expect((await bob.get(`/api/v1/datasets/${datasetId}/preview?version=1`)).statusCode).toBe(404);
    expect((await bob.post(`/api/v1/datasets/${datasetId}/publish`, {})).statusCode).toBe(403);

    const anon = new TestClient(h.app);
    expect((await anon.get(`/api/v1/datasets/${datasetId}/concepts/tables/returns`)).statusCode).toBe(200);
    const results = (await anon.get('/api/v1/search?q=northwind')).json();
    expect(results.data.map((r: { dataset: { id: string } }) => r.dataset.id)).toEqual([datasetId]);
  });

  it('serves the API to API keys and records an audit trail', async () => {
    const key = await alice.post('/api/v1/api-keys', { organizationId: orgId, name: 'ci', scopes: ['datasets:read'], expiresInDays: 30 });
    expect(key.statusCode).toBe(201);
    const raw: string = key.json().key;
    expect(raw).toMatch(/^okf_[A-Za-z0-9]{8}_/);

    const api = new TestClient(h.app);
    api.bearer = raw;
    const res = await api.get(`/api/v1/datasets/${datasetId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().usage.apiRequests).toBeGreaterThan(0);
    const q = await api.post(`/api/v1/datasets/${datasetId}/query/sql`, { sql: 'SELECT count(*) AS n FROM concepts' });
    expect(q.json().rows).toEqual([{ n: '5' }]);
    // A read-only key cannot upload, and keys never manage keys.
    expect((await api.post(`/api/v1/datasets/${datasetId}/uploads`, { filename: 'x.zip', size: 10 })).statusCode).toBe(403);
    expect((await api.post('/api/v1/api-keys', { organizationId: orgId, name: 'x', scopes: ['datasets:read'] })).statusCode).toBe(403);

    const audit = (await alice.get(`/api/v1/organizations/${orgId}/audit-logs?pageSize=100`)).json();
    const actions = audit.data.map((a: { action: string }) => a.action);
    for (const a of ['org.created', 'dataset.created', 'upload.created', 'version.created', 'version.validated', 'dataset.published', 'dataset.visibility_changed', 'api_key.created', 'query.sql']) {
      expect(actions, a).toContain(a);
    }
    const apiQuery = audit.data.find((a: { action: string; actorType: string }) => a.action === 'query.sql' && a.actorType === 'api_key');
    expect(apiQuery).toBeDefined();

    const revoked = await alice.delete(`/api/v1/api-keys/${key.json().id}`);
    expect(revoked.statusCode).toBe(204);
    expect((await api.get(`/api/v1/datasets/${datasetId}`)).statusCode).toBe(401);
  });
});

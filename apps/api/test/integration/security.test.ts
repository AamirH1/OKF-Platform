import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildZip } from '../../../../packages/archive/test/builders';
import { createHarness, packFixture, TestClient, type TestHarness, uploadFile } from '../../../../tests/setup/app';

let h: TestHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  h.mailer.sent.length = 0;
});

async function orgWithDataset(owner: TestClient, visibility: 'private' | 'organization' | 'public' = 'organization') {
  const org = (await owner.post('/api/v1/organizations', { name: `Org ${Math.random().toString(36).slice(2, 7)}` })).json();
  const ds = (await owner.post('/api/v1/datasets', { organizationId: org.id, name: 'Sales', visibility })).json();
  return { orgId: org.id as string, datasetId: ds.id as string };
}

async function invite(owner: TestClient, orgId: string, member: TestClient, email: string, role: string) {
  const inv = await owner.post(`/api/v1/organizations/${orgId}/invitations`, { email, role });
  expect(inv.statusCode).toBe(201);
  const token = new URL(inv.json().acceptUrl).searchParams.get('token')!;
  const accepted = await member.post('/api/v1/invitations/accept', { token });
  expect(accepted.statusCode).toBe(200);
}

describe('authentication and sessions', () => {
  it('rejects cookie-authenticated mutations without a CSRF token or from foreign origins', async () => {
    const a = new TestClient(h.app);
    await a.signup('a@example.com');
    const csrf = a.csrf;
    a.csrf = null;
    const noToken = await a.post('/api/v1/organizations', { name: 'X' });
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json().error.code).toBe('CSRF_FAILED');
    a.csrf = csrf;
    const foreign = await a.post('/api/v1/organizations', { name: 'X' }, { origin: 'https://evil.example' });
    expect(foreign.json().error.code).toBe('ORIGIN_REJECTED');
    expect((await a.post('/api/v1/organizations', { name: 'X' })).statusCode).toBe(201);
  });

  it('does not reveal accounts, audits failed logins, and validates input', async () => {
    const a = new TestClient(h.app);
    await a.signup('a@example.com');
    const anon = new TestClient(h.app);
    const wrong = await anon.post('/api/v1/auth/login', { email: 'a@example.com', password: 'nope' });
    const missing = await anon.post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'nope' });
    expect([wrong.statusCode, missing.statusCode]).toEqual([401, 401]);
    expect(wrong.json().error.message).toBe(missing.json().error.message);
    expect((await anon.post('/api/v1/auth/forgot-password', { email: 'nobody@example.com' })).statusCode).toBe(202);
    const weak = await anon.post('/api/v1/auth/signup', { email: 'b@example.com', password: 'short', name: 'B' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(wrong.headers['x-request-id']).toBeTruthy();
    expect((await anon.post('/api/v1/auth/signup', { email: 'A@EXAMPLE.com', password: 'another long password', name: 'dup' })).statusCode).toBe(409);
  });

  it('resets a password by email token and signs out every session', async () => {
    const a = new TestClient(h.app);
    await a.signup('a@example.com');
    const anon = new TestClient(h.app);
    expect((await anon.post('/api/v1/auth/forgot-password', { email: 'a@example.com' })).statusCode).toBe(202);
    const mail = h.mailer.sent.at(-1)!;
    const token = /token=([^\s]+)/.exec(mail.text)![1]!;
    expect((await anon.post('/api/v1/auth/reset-password', { token: decodeURIComponent(token), password: 'a brand new password' })).statusCode).toBe(204);
    expect((await a.get('/api/v1/users/me')).statusCode).toBe(401);
    expect((await anon.post('/api/v1/auth/reset-password', { token: decodeURIComponent(token), password: 'yet another password' })).json().error.code).toBe('INVALID_TOKEN');
    expect((await anon.post('/api/v1/auth/login', { email: 'a@example.com', password: 'a brand new password' })).statusCode).toBe(200);
  });

  it('lists and revokes sessions', async () => {
    const a1 = new TestClient(h.app);
    await a1.signup('a@example.com');
    const a2 = new TestClient(h.app);
    await a2.post('/api/v1/auth/login', { email: 'a@example.com', password: 'correct horse battery staple' });
    const list = (await a1.get('/api/v1/auth/sessions')).json().data;
    expect(list).toHaveLength(2);
    const other = list.find((s: { current: boolean }) => !s.current);
    expect((await a1.delete(`/api/v1/auth/sessions/${other.id}`)).statusCode).toBe(204);
    expect((await a2.get('/api/v1/users/me')).statusCode).toBe(401);
  });

  it('rate-limits authentication endpoints', async () => {
    const limited = await createHarness({ AUTH_RATE_LIMIT_MAX: '3' });
    try {
      const c = new TestClient(limited.app);
      const codes = [];
      for (let i = 0; i < 4; i++) codes.push((await c.post('/api/v1/auth/login', { email: 'x@example.com', password: 'y' })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('organizations and RBAC', () => {
  it('enforces roles for members and protects the last owner', async () => {
    const owner = new TestClient(h.app);
    const ownerMe = await owner.signup('owner@example.com');
    const { orgId, datasetId } = await orgWithDataset(owner);
    const viewer = new TestClient(h.app);
    const viewerMe = await viewer.signup('viewer@example.com');
    const admin = new TestClient(h.app);
    await admin.signup('admin@example.com');

    // Invitations must be accepted by the invited email.
    const inv = (await owner.post(`/api/v1/organizations/${orgId}/invitations`, { email: 'viewer@example.com', role: 'viewer' })).json();
    const token = new URL(inv.acceptUrl).searchParams.get('token')!;
    expect((await admin.post('/api/v1/invitations/accept', { token })).json().error.code).toBe('EMAIL_MISMATCH');
    expect((await viewer.post('/api/v1/invitations/accept', { token })).statusCode).toBe(200);
    expect(h.mailer.sent.some((m) => m.to === 'viewer@example.com')).toBe(true);
    await invite(owner, orgId, admin, 'admin@example.com', 'admin');

    // Viewer: read yes, write no.
    expect((await viewer.get(`/api/v1/datasets/${datasetId}`)).statusCode).toBe(200);
    expect((await viewer.post(`/api/v1/datasets/${datasetId}/uploads`, { filename: 'b.zip', size: 100 })).statusCode).toBe(403);
    expect((await viewer.post('/api/v1/datasets', { organizationId: orgId, name: 'Nope' })).statusCode).toBe(403);
    expect((await viewer.get(`/api/v1/organizations/${orgId}/audit-logs`)).statusCode).toBe(403);

    // Admins manage members but not owners/admins.
    expect((await admin.patch(`/api/v1/organizations/${orgId}/members/${viewerMe.user.id}`, { role: 'editor' })).statusCode).toBe(200);
    expect((await admin.patch(`/api/v1/organizations/${orgId}/members/${viewerMe.user.id}`, { role: 'owner' })).statusCode).toBe(403);
    expect((await admin.delete(`/api/v1/organizations/${orgId}/members/${ownerMe.user.id}`)).statusCode).toBe(403);
    expect((await viewer.post(`/api/v1/datasets/${datasetId}/uploads`, { filename: 'b.zip', size: 100 })).statusCode).toBe(201);

    // The last owner can neither leave nor be demoted.
    expect((await owner.patch(`/api/v1/organizations/${orgId}/members/${ownerMe.user.id}`, { role: 'admin' })).json().error.code).toBe('LAST_OWNER');
    expect((await owner.delete(`/api/v1/organizations/${orgId}/members/${ownerMe.user.id}`)).json().error.code).toBe('LAST_OWNER');

    // Outsiders cannot tell the organization or dataset exist.
    const outsider = new TestClient(h.app);
    await outsider.signup('out@example.com');
    expect((await outsider.get(`/api/v1/organizations/${orgId}`)).statusCode).toBe(404);
    expect((await outsider.get(`/api/v1/datasets/${datasetId}`)).statusCode).toBe(404);
  });

  it('hides private datasets from members until granted; share links expose only the published version', async () => {
    const owner = new TestClient(h.app);
    await owner.signup('owner@example.com');
    const { orgId, datasetId } = await orgWithDataset(owner, 'private');
    const member = new TestClient(h.app);
    await member.signup('member@example.com');
    await invite(owner, orgId, member, 'member@example.com', 'viewer');

    expect((await member.get(`/api/v1/datasets/${datasetId}`)).statusCode).toBe(404);
    expect((await member.get('/api/v1/datasets')).json().page.total).toBe(0);
    expect((await owner.post(`/api/v1/datasets/${datasetId}/grants`, { email: 'member@example.com', role: 'viewer' })).statusCode).toBe(201);
    expect((await member.get(`/api/v1/datasets/${datasetId}`)).json().access).toBe('reader');

    await uploadFile(owner, datasetId, await packFixture(h.tmp, 'valid-minimal'));
    await h.drainJobs();
    const link = (await owner.post(`/api/v1/datasets/${datasetId}/share-links`, { label: 'partner', expiresInDays: 7 })).json();
    const anon = new TestClient(h.app);
    // Not yet published: a share link grants nothing.
    expect((await anon.get(`/api/v1/shared/${link.token}`)).statusCode).toBe(404);
    await owner.post(`/api/v1/datasets/${datasetId}/publish`, {});
    const shared = await anon.get(`/api/v1/shared/${link.token}`);
    expect(shared.json()).toMatchObject({ id: datasetId, access: 'public', latestVersion: null });
    expect((await anon.get(`/api/v1/datasets/${datasetId}/preview`, { 'x-share-token': link.token })).statusCode).toBe(200);
    expect((await anon.get(`/api/v1/datasets/${datasetId}/preview`)).statusCode).toBe(404);
    expect((await anon.get(`/api/v1/search?q=sales`)).json().page.total).toBe(0);
    await owner.delete(`/api/v1/datasets/${datasetId}/share-links/${link.id}`);
    expect((await anon.get(`/api/v1/datasets/${datasetId}/preview`, { 'x-share-token': link.token })).statusCode).toBe(404);
  });

  it('confines API keys to their organization', async () => {
    const a = new TestClient(h.app);
    await a.signup('a@example.com');
    const one = await orgWithDataset(a);
    const two = await orgWithDataset(a);
    const key = (await a.post('/api/v1/api-keys', { organizationId: one.orgId, name: 'k', scopes: ['datasets:read', 'datasets:write'] })).json().key;
    const api = new TestClient(h.app);
    api.bearer = key;
    expect((await api.get(`/api/v1/datasets/${one.datasetId}`)).statusCode).toBe(200);
    expect((await api.get(`/api/v1/datasets/${two.datasetId}`)).statusCode).toBe(404);
    expect((await api.get('/api/v1/organizations')).json().data.map((o: { id: string }) => o.id)).toEqual([one.orgId]);
    expect((await api.delete(`/api/v1/datasets/${one.datasetId}`)).statusCode).toBe(403);
    const bad = new TestClient(h.app);
    bad.bearer = `${key.slice(0, -4)}AAAA`;
    expect((await bad.get(`/api/v1/datasets/${one.datasetId}`)).statusCode).toBe(401);
  });
});

describe('ingestion failure modes', () => {
  let owner: TestClient;
  let datasetId: string;
  beforeEach(async () => {
    owner = new TestClient(h.app);
    await owner.signup('owner@example.com');
    ({ datasetId } = await orgWithDataset(owner));
  });

  const latest = async () => (await owner.get(`/api/v1/datasets/${datasetId}`)).json().latestVersion;

  it('marks non-conformant bundles FAILED with a structured report and refuses to publish them', async () => {
    await uploadFile(owner, datasetId, await packFixture(h.tmp, 'invalid-missing-type'));
    await h.drainJobs();
    const v = await latest();
    expect(v).toMatchObject({ status: 'FAILED', valid: false, errorCount: 3, failure: { code: 'OKF_NONCONFORMANT', stage: 'validate' } });
    const report = (await owner.get(`/api/v1/datasets/${datasetId}/validation?severity=error`)).json();
    expect(report.issues.data.map((i: { code: string }) => i.code).sort()).toEqual(['OKF_MISSING_FRONTMATTER', 'OKF_MISSING_TYPE', 'OKF_MISSING_TYPE']);
    expect(report.issues.data[0]).toMatchObject({ layer: 'structural', location: { path: expect.any(String) } });
    expect((await owner.post(`/api/v1/datasets/${datasetId}/publish`, { version: 1 })).json().error.code).toBe('NOT_PUBLISHABLE');
    expect((await owner.get(`/api/v1/datasets/${datasetId}`)).json().status).toBe('FAILED');
  });

  it('rejects zip-slip archives without writing outside the sandbox', async () => {
    const file = path.join(h.tmp, 'evil.zip');
    await writeFile(file, buildZip([{ name: 'ok.md', data: '---\ntype: X\n---\n' }, { name: '../../evil.md', data: 'pwned' }]));
    await uploadFile(owner, datasetId, file);
    await h.drainJobs();
    expect((await latest()).failure).toMatchObject({ code: 'PATH_TRAVERSAL', stage: 'extract' });
  });

  it('rejects archives that are not OKF bundles and content/extension mismatches', async () => {
    const txt = path.join(h.tmp, 'notes.zip');
    await writeFile(txt, buildZip([{ name: 'readme.txt', data: 'hello' }]));
    await uploadFile(owner, datasetId, txt);
    await h.drainJobs();
    expect((await latest()).failure.code).toBe('NOT_OKF_BUNDLE');

    const fake = path.join(h.tmp, 'fake.tar.gz');
    await writeFile(fake, buildZip([{ name: 'a.md', data: '---\ntype: X\n---\n' }]));
    await uploadFile(owner, datasetId, fake);
    await h.drainJobs();
    expect((await latest()).failure.code).toBe('EXTENSION_MISMATCH');
  });

  it('cancels a queued ingestion', async () => {
    const v = await uploadFile(owner, datasetId, await packFixture(h.tmp, 'valid-minimal'));
    const res = await owner.post(`/api/v1/jobs/${v.job.id}/cancel`);
    expect(res.json().status).toBe('CANCELLED');
    expect(await h.drainJobs()).toBe(0);
    expect((await latest()).failure.code).toBe('CANCELLED');
  });

  it('validates uploads and imports up front', async () => {
    expect((await owner.post(`/api/v1/datasets/${datasetId}/uploads`, { filename: 'x.exe', size: 10 })).statusCode).toBe(400);
    expect((await owner.post(`/api/v1/datasets/${datasetId}/uploads`, { filename: '../x.zip', size: 10 })).statusCode).toBe(400);
    expect((await owner.post(`/api/v1/datasets/${datasetId}/uploads`, { filename: 'x.zip', size: 10 * 1024 ** 4 })).json().error.code).toBe('FILE_TOO_LARGE');
    for (const url of ['https://localhost/a.zip', 'https://169.254.169.254/latest', 'http://example.com/a.zip', 'file:///etc/passwd']) {
      expect((await owner.post(`/api/v1/datasets/${datasetId}/imports`, { url })).statusCode, url).toBe(400);
    }
  });
});

describe('platform endpoints', () => {
  it('serves health, readiness, metrics and the OpenAPI document', async () => {
    const c = new TestClient(h.app);
    expect((await c.get('/health')).json()).toEqual({ status: 'ok' });
    expect((await c.get('/ready')).json()).toMatchObject({ status: 'ready', checks: { database: 'ok', storage: 'ok' } });
    expect((await c.get('/metrics')).body).toContain('okf_http_request_duration_seconds');
    const doc = (await c.get('/api/v1/openapi.json')).json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/v1/datasets', '/api/v1/datasets/{id}/query', '/api/v1/search']));
    expect(doc.components.schemas.Dataset).toBeDefined();
    const res = await c.get('/api/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

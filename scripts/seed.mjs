#!/usr/bin/env node
// Seed a demo account through the public API (so data goes through the real pipeline).
// Requires the stack running (`npm run dev`). Usage:
//   npm run seed                       # demo@okf.local / password printed below
//   SEED_EMAIL=me@x.com SEED_PASSWORD='…' npm run seed
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { create } from 'tar';

const API = process.env.API_URL ?? 'http://localhost:4000';
const email = process.env.SEED_EMAIL ?? 'demo@okf.local';
const password = process.env.SEED_PASSWORD ?? 'demo password for okf';
const root = path.resolve(import.meta.dirname, '..');
const cookies = new Map();

async function call(method, url, body) {
  const headers = { 'content-type': 'application/json' };
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  if (method !== 'GET' && cookies.has('okf_csrf')) headers['x-csrf-token'] = cookies.get('okf_csrf');
  const res = await fetch(`${API}/api/v1${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    cookies.set(k, v);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(`${method} ${url} → ${res.status}: ${data?.error?.message ?? text}`), { status: res.status });
  return data;
}

async function upload(datasetId, fixture) {
  const file = path.join(os.tmpdir(), `okf-seed-${fixture}.tar.gz`);
  await create({ gzip: true, file, cwd: path.join(root, 'tests/fixtures/okf') }, [fixture]);
  const bytes = await readFile(file);
  const s = await call('POST', `/datasets/${datasetId}/uploads`, { filename: `${fixture}.tar.gz`, size: bytes.length, contentType: 'application/gzip', notes: 'Seeded sample bundle' });
  const parts = [];
  for (const p of s.parts) {
    const res = await fetch(p.url, { method: 'PUT', body: bytes.subarray((p.partNumber - 1) * s.partSize, p.partNumber * s.partSize) });
    if (!res.ok) throw new Error(`part upload failed: ${res.status}`);
    parts.push({ partNumber: p.partNumber, etag: res.headers.get('etag') });
  }
  return call('POST', `/datasets/${datasetId}/uploads/${s.uploadId}/complete`, { parts });
}

try {
  await call('POST', '/auth/signup', { email, password, name: 'Demo User' });
  console.log(`created ${email}`);
} catch (e) {
  if (e.status !== 409) throw e;
  await call('POST', '/auth/login', { email, password });
  console.log(`signed in as existing ${email}`);
}
const me = await call('GET', '/users/me');
const org = me.organizations.find((o) => o.slug.startsWith('demo')) ?? (await call('POST', '/organizations', { name: 'Demo', slug: `demo-${Date.now().toString(36)}` }));

const samples = [
  { fixture: 'acme_retail', name: 'Acme Retail', description: "Google's acme_retail sample: metrics, attested computations and policies (OKF v0.2).", tags: ['finance', 'sample'], visibility: 'public' },
  { fixture: 'stackoverflow', name: 'Stack Overflow public dataset', description: "Google's reference-agent bundle for the BigQuery Stack Overflow dataset.", tags: ['bigquery', 'sample'], visibility: 'organization' },
  { fixture: 'valid-minimal', name: 'Northwind Analytics', description: 'Small hand-written bundle with tables, a metric and a playbook.', tags: ['sales'], visibility: 'organization' },
  { fixture: 'invalid-missing-type', name: 'Broken bundle (validation demo)', description: 'Intentionally non-conformant: missing `type` and frontmatter.', tags: ['demo'], visibility: 'private' },
];
for (const s of samples) {
  const ds = await call('POST', '/datasets', { organizationId: org.id, name: s.name, description: s.description, tags: s.tags, visibility: s.visibility });
  const v = await upload(ds.id, s.fixture);
  console.log(`uploaded ${s.fixture} → dataset ${ds.id} v${v.number} (job ${v.job.id})`);
  if (s.visibility === 'public') {
    // Public datasets are only visible once published: wait for the worker, then publish.
    for (let i = 0; i < 60; i++) {
      const job = await call('GET', `/jobs/${v.job.id}`);
      if (job.status === 'COMPLETED') {
        await call('POST', `/datasets/${ds.id}/publish`, {});
        console.log(`  published ${s.name}`);
        break;
      }
      if (job.status === 'FAILED' || job.status === 'CANCELLED') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
console.log(`\nSeeded. The worker processes uploads in the background.\nSign in at http://localhost:3000/login as ${email} / ${password}`);

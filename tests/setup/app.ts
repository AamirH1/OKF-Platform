import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import pino from 'pino';
import { create as createTar } from 'tar';
import { buildApp, type AppDeps } from '@okf/api';
import { MemoryMailer } from '../../apps/api/src/lib/mailer';
import { createMetrics } from '../../apps/api/src/lib/observability';
import { createArtifactLoader } from '../../apps/api/src/services/artifacts';
import { PostgresSearchProvider } from '../../apps/api/src/services/search';
import { NoopScanner } from '@okf/archive';
import { loadEnv } from '@okf/config';
import { claimJob, createDb, type JobType } from '@okf/db';
import { DuckDbQueryEngine } from '@okf/query';
import { createStorage } from '@okf/storage';
import { createRunner, createWorkerMetrics, type Runner } from '@okf/worker';
import { resetDatabase } from './db';

export const FIXTURES = path.resolve(import.meta.dirname, '../fixtures/okf');

export interface TestHarness {
  app: FastifyInstance;
  deps: AppDeps;
  mailer: MemoryMailer;
  runner: Runner;
  tmp: string;
  reset(): Promise<void>;
  /** Run queued jobs in-process until the queue is empty (the real worker pipeline). */
  drainJobs(types?: JobType[]): Promise<number>;
  close(): Promise<void>;
}

export async function createHarness(overrides: Record<string, string> = {}): Promise<TestHarness> {
  const env = loadEnv({ ...process.env, RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_MAX: '100000', ...overrides });
  const handle = createDb(env.DATABASE_URL, 5);
  const storage = createStorage(env);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'okf-it-'));
  const query = new DuckDbQueryEngine({
    loadArtifacts: createArtifactLoader(storage, path.join(tmp, 'query-cache')),
    timeoutMs: env.QUERY_TIMEOUT_MS,
    maxRows: env.QUERY_MAX_ROWS,
    memoryLimit: env.QUERY_MEMORY_LIMIT,
    cacheEntries: 4,
  });
  const mailer = new MemoryMailer();
  const deps: AppDeps = {
    env,
    db: handle.db,
    storage,
    redis: null,
    query,
    mailer,
    metrics: createMetrics(),
    reporter: { capture: () => undefined },
    search: new PostgresSearchProvider(handle.db),
  };
  const app = await buildApp(deps);
  const log = pino({ level: 'silent' });
  const runner = createRunner({ env: { ...env, WORKER_TEMP_DIR: tmp }, db: handle.db, storage, scanner: new NoopScanner(), log, metrics: createWorkerMetrics() });
  return {
    app,
    deps,
    mailer,
    runner,
    tmp,
    reset: () => resetDatabase(handle.db),
    async drainJobs(types = ['ingest_version', 'diff_versions', 'purge_dataset']) {
      let n = 0;
      for (;;) {
        const job = await claimJob(handle.db, runner.workerId, types);
        if (!job) return n;
        await runner.execute(job);
        n++;
      }
    },
    async close() {
      await app.close();
      await query.close();
      await handle.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/** Pack a fixture directory as .tar.gz (wrapped in a top-level folder, like real tarballs). */
export async function packFixture(tmp: string, fixture: string, name = `${path.basename(fixture)}.tar.gz`): Promise<string> {
  const out = path.join(tmp, name);
  await createTar({ gzip: true, file: out, cwd: path.dirname(path.join(FIXTURES, fixture)), portable: true }, [path.basename(fixture)]);
  return out;
}

/** Cookie + CSRF aware client over `app.inject`, mirroring what the browser does. */
export class TestClient {
  private cookies = new Map<string, string>();
  csrf: string | null = null;
  bearer: string | null = null;

  constructor(private readonly app: FastifyInstance) {}

  async request(method: InjectOptions['method'], url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const h: Record<string, string> = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    const res = await this.app.inject({ method, url, headers: h, ...(body !== undefined ? { payload: body as object } : {}) });
    for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
      if (!c.value || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
      if (c.name === 'okf_csrf') this.csrf = c.value || null;
    }
    return res;
  }

  get = (url: string, headers?: Record<string, string>) => this.request('GET', url, undefined, headers);
  post = (url: string, body?: unknown, headers?: Record<string, string>) => this.request('POST', url, body ?? {}, headers);
  patch = (url: string, body?: unknown) => this.request('PATCH', url, body ?? {});
  put = (url: string, body?: unknown) => this.request('PUT', url, body ?? {});
  delete = (url: string) => this.request('DELETE', url);

  async signup(email: string, name = email.split('@')[0]!, password = 'correct horse battery staple') {
    const res = await this.post('/api/v1/auth/signup', { email, password, name });
    if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
    return res.json() as { user: { id: string } };
  }
}

/** Upload a file through the real presigned multipart flow and complete it. */
export async function uploadFile(client: TestClient, datasetId: string, file: string, filename = path.basename(file)) {
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(file);
  const start = await client.post(`/api/v1/datasets/${datasetId}/uploads`, { filename, size: bytes.length, contentType: 'application/gzip' });
  if (start.statusCode !== 201) throw new Error(`upload start failed: ${start.statusCode} ${start.body}`);
  const session = start.json() as { uploadId: string; partSize: number; parts: { partNumber: number; url: string }[] };
  const parts: { partNumber: number; etag: string }[] = [];
  for (const p of session.parts) {
    const slice = bytes.subarray((p.partNumber - 1) * session.partSize, p.partNumber * session.partSize);
    const res = await fetch(p.url, { method: 'PUT', body: slice });
    if (!res.ok) throw new Error(`part upload failed: ${res.status}`);
    parts.push({ partNumber: p.partNumber, etag: res.headers.get('etag')! });
  }
  const done = await client.post(`/api/v1/datasets/${datasetId}/uploads/${session.uploadId}/complete`, { parts });
  if (done.statusCode !== 201) throw new Error(`upload complete failed: ${done.statusCode} ${done.body}`);
  return done.json() as { id: string; number: number; status: string; job: { id: string; status: string } };
}

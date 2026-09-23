import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../../../tests/setup/db';
import {
  claimJob,
  completeJob,
  concepts,
  createDb,
  datasets,
  datasetVersions,
  enqueueJob,
  eq,
  failJob,
  heartbeatJob,
  jobs,
  LostJobLockError,
  organizations,
  pgErrorCode,
  PG_CHECK_VIOLATION,
  reapStaleJobs,
  requestJobCancel,
  sql,
} from '../src';

const { db, close } = createDb(process.env.DATABASE_URL!, 5);
afterAll(close);
beforeEach(() => resetDatabase(db));

async function seedVersion(status: 'PROCESSING' | 'VALIDATED' = 'PROCESSING') {
  const [org] = await db.insert(organizations).values({ name: 'Acme', slug: `acme-${Math.random().toString(36).slice(2, 8)}` }).returning();
  const [ds] = await db.insert(datasets).values({ organizationId: org!.id, slug: 'sales', name: 'Sales' }).returning();
  const [v] = await db
    .insert(datasetVersions)
    .values({ datasetId: ds!.id, organizationId: org!.id, number: 1, sourceType: 'upload', originalFilename: 'b.zip', archiveKey: 'k', status })
    .returning();
  return { org: org!, ds: ds!, v: v! };
}

describe('job queue', () => {
  it('claims each job exactly once under concurrency (SKIP LOCKED)', async () => {
    for (let i = 0; i < 20; i++) await enqueueJob(db, { type: 'ingest_version' });
    const claimed = await Promise.all(Array.from({ length: 30 }, (_, i) => claimJob(db, `w${i}`, ['ingest_version'])));
    const ids = claimed.filter(Boolean).map((j) => j!.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('only claims requested types and respects run_after', async () => {
    await enqueueJob(db, { type: 'diff_versions' });
    await enqueueJob(db, { type: 'ingest_version', runAfter: new Date(Date.now() + 60_000) });
    expect(await claimJob(db, 'w', ['ingest_version'])).toBeNull();
    expect((await claimJob(db, 'w', ['diff_versions']))?.type).toBe('diff_versions');
  });

  it('retries retryable failures with backoff, then fails', async () => {
    const job = await enqueueJob(db, { type: 'ingest_version', maxAttempts: 2 });
    const a1 = (await claimJob(db, 'w', ['ingest_version']))!;
    expect(await failJob(db, a1, 'w', { code: 'X', message: 'boom', retryable: true })).toBe('retrying');
    const [queued] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(queued!.status).toBe('QUEUED');
    expect(queued!.runAfter.getTime()).toBeGreaterThan(Date.now());
    await db.update(jobs).set({ runAfter: new Date(0) }).where(eq(jobs.id, job.id));
    const a2 = (await claimJob(db, 'w', ['ingest_version']))!;
    expect(a2.attempts).toBe(2);
    expect(await failJob(db, a2, 'w', { code: 'X', message: 'boom', retryable: true })).toBe('failed');
  });

  it('heartbeats report cancellation and detect lost locks', async () => {
    const job = await enqueueJob(db, { type: 'ingest_version' });
    await claimJob(db, 'w1', ['ingest_version']);
    expect(await heartbeatJob(db, job.id, 'w1', { stage: 'parse', progress: 40 })).toEqual({ cancelRequested: false });
    expect(await requestJobCancel(db, job.id)).toBe('RUNNING');
    expect(await heartbeatJob(db, job.id, 'w1')).toEqual({ cancelRequested: true });
    await expect(heartbeatJob(db, job.id, 'intruder')).rejects.toBeInstanceOf(LostJobLockError);
    await completeJob(db, job.id, 'w1', { ok: true });
    const [done] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(done).toMatchObject({ status: 'COMPLETED', progress: 100, stage: 'parse' });
  });

  it('cancels queued jobs immediately', async () => {
    const job = await enqueueJob(db, { type: 'ingest_version' });
    expect(await requestJobCancel(db, job.id)).toBe('CANCELLED');
    expect(await claimJob(db, 'w', ['ingest_version'])).toBeNull();
  });

  it('reaps jobs whose worker died', async () => {
    const job = await enqueueJob(db, { type: 'ingest_version' });
    await claimJob(db, 'dead', ['ingest_version']);
    await db.update(jobs).set({ heartbeatAt: new Date(Date.now() - 120_000) }).where(eq(jobs.id, job.id));
    const reaped = await reapStaleJobs(db, 60_000);
    expect(reaped).toEqual([expect.objectContaining({ id: job.id, status: 'QUEUED' })]);
    expect((await claimJob(db, 'alive', ['ingest_version']))?.id).toBe(job.id);
  });
});

describe('version immutability triggers', () => {
  const expectCheckViolation = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(pgErrorCode(err)).toBe(PG_CHECK_VIOLATION);
  };

  it('allows writes while PROCESSING and freezes content afterwards', async () => {
    const { v } = await seedVersion();
    await db.update(datasetVersions).set({ conceptCount: 3, valid: true, status: 'VALIDATED' }).where(eq(datasetVersions.id, v.id));
    await expectCheckViolation(db.update(datasetVersions).set({ conceptCount: 4 }).where(eq(datasetVersions.id, v.id)));
    await expectCheckViolation(db.update(datasetVersions).set({ status: 'FAILED' }).where(eq(datasetVersions.id, v.id)));
    await db.update(datasetVersions).set({ status: 'PUBLISHED', publishedAt: new Date() }).where(eq(datasetVersions.id, v.id));
    await expectCheckViolation(db.update(datasetVersions).set({ publishedAt: new Date(0) }).where(eq(datasetVersions.id, v.id)));
    await expectCheckViolation(db.update(datasetVersions).set({ status: 'VALIDATED' }).where(eq(datasetVersions.id, v.id)));
    await expectCheckViolation(db.delete(datasetVersions).where(eq(datasetVersions.id, v.id)));
  });

  it('rejects child rows for processed versions', async () => {
    const { v, ds, org } = await seedVersion('VALIDATED');
    await expectCheckViolation(
      db.insert(concepts).values({
        versionId: v.id, datasetId: ds.id, organizationId: org.id, conceptId: 'x', path: 'x.md', type: 'T', title: 'X',
        titleDerived: false, tags: [], status: 'stable', trustTier: 'unverified', isStale: false, verifiedBy: [],
        sourceCount: 0, linkCount: 0, brokenLinkCount: 0, wordCount: 0, bytes: 1, sha256: 'a', frontmatter: {}, headings: [],
        sources: [], excerpt: '',
      }),
    );
  });

  it('permits deleting a published version only during an explicit purge', async () => {
    const { v } = await seedVersion();
    await db.update(datasetVersions).set({ status: 'VALIDATED' }).where(eq(datasetVersions.id, v.id));
    await db.update(datasetVersions).set({ status: 'PUBLISHED' }).where(eq(datasetVersions.id, v.id));
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL okf.allow_purge = 'on'`);
      await tx.delete(datasetVersions).where(eq(datasetVersions.id, v.id));
    });
    expect(await db.select().from(datasetVersions).where(eq(datasetVersions.id, v.id))).toEqual([]);
  });

  it('computes dataset and concept search vectors', async () => {
    const { ds } = await seedVersion();
    await db.update(datasets).set({ description: 'Orders shipped to customers', searchText: 'BigQuery Table order_id' }).where(eq(datasets.id, ds.id));
    const rows = await db.execute(sql`SELECT id FROM datasets WHERE search @@ websearch_to_tsquery('english', 'shipped order_id')`);
    expect(rows.rows).toHaveLength(1);
  });
});

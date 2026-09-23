import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Database, Executor } from './client';
import { jobs } from './schema';

export type Job = typeof jobs.$inferSelect;
export type JobType = 'ingest_version' | 'diff_versions' | 'purge_dataset';

export interface JobError {
  code: string;
  message: string;
  stage?: string | null;
  retryable?: boolean;
}

export interface EnqueueInput {
  type: JobType;
  organizationId?: string | null;
  datasetId?: string | null;
  versionId?: string | null;
  payload?: Record<string, unknown>;
  createdBy?: string | null;
  maxAttempts?: number;
  runAfter?: Date;
}

/** Thrown when a worker no longer owns a job (reaped after a missed heartbeat). */
export class LostJobLockError extends Error {
  constructor(jobId: string) {
    super(`Lost lock on job ${jobId}`);
    this.name = 'LostJobLockError';
  }
}

/** Insert a job. Pass a transaction to enqueue atomically with the domain change (ADR-0002). */
export async function enqueueJob(ex: Executor, input: EnqueueInput): Promise<Job> {
  const [job] = await ex
    .insert(jobs)
    .values({
      type: input.type,
      organizationId: input.organizationId ?? null,
      datasetId: input.datasetId ?? null,
      versionId: input.versionId ?? null,
      payload: input.payload ?? {},
      createdBy: input.createdBy ?? null,
      maxAttempts: input.maxAttempts ?? 3,
      runAfter: input.runAfter ?? new Date(),
    })
    .returning();
  return job!;
}

/** Atomically claim the next runnable job of the given types, or null. */
export async function claimJob(db: Database, workerId: string, types: JobType[]): Promise<Job | null> {
  const next = sql`(
    SELECT id FROM ${jobs}
    WHERE status = 'QUEUED' AND run_after <= now() AND type IN (${sql.join(types.map((t) => sql`${t}`), sql`, `)})
    ORDER BY run_after, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )`;
  const [job] = await db
    .update(jobs)
    .set({
      status: 'RUNNING',
      lockedBy: workerId,
      lockedAt: sql`now()`,
      heartbeatAt: sql`now()`,
      startedAt: sql`coalesce(${jobs.startedAt}, now())`,
      attempts: sql`${jobs.attempts} + 1`,
      error: null,
    })
    .where(eq(jobs.id, next))
    .returning();
  return job ?? null;
}

/** Record liveness and progress. Returns whether cancellation was requested. */
export async function heartbeatJob(
  db: Database,
  jobId: string,
  workerId: string,
  update: { stage?: string; progress?: number } = {},
): Promise<{ cancelRequested: boolean }> {
  const [row] = await db
    .update(jobs)
    .set({
      heartbeatAt: sql`now()`,
      ...(update.stage !== undefined ? { stage: update.stage } : {}),
      ...(update.progress !== undefined ? { progress: Math.max(0, Math.min(100, Math.round(update.progress))) } : {}),
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId), eq(jobs.status, 'RUNNING')))
    .returning({ cancelRequested: jobs.cancelRequested });
  if (!row) throw new LostJobLockError(jobId);
  return row;
}

export async function completeJob(ex: Executor, jobId: string, workerId: string, result: unknown = null): Promise<void> {
  const rows = await ex
    .update(jobs)
    .set({ status: 'COMPLETED', result, progress: 100, finishedAt: sql`now()`, lockedBy: null, lockedAt: null })
    .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId)))
    .returning({ id: jobs.id });
  if (rows.length === 0) throw new LostJobLockError(jobId);
}

export function backoffMs(attempt: number): number {
  return Math.min(10 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Record a failure. Retryable errors are re-queued with exponential backoff until
 * `max_attempts`; returns the resulting state.
 */
export async function failJob(ex: Executor, job: Pick<Job, 'id' | 'attempts' | 'maxAttempts'>, workerId: string, error: JobError): Promise<'retrying' | 'failed'> {
  const retry = error.retryable === true && job.attempts < job.maxAttempts;
  const rows = await ex
    .update(jobs)
    .set(
      retry
        ? { status: 'QUEUED', error, lockedBy: null, lockedAt: null, runAfter: new Date(Date.now() + backoffMs(job.attempts)) }
        : { status: 'FAILED', error, lockedBy: null, lockedAt: null, finishedAt: sql`now()` },
    )
    .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId)))
    .returning({ id: jobs.id });
  if (rows.length === 0) throw new LostJobLockError(job.id);
  return retry ? 'retrying' : 'failed';
}

export async function markJobCancelled(ex: Executor, jobId: string, workerId: string): Promise<void> {
  await ex
    .update(jobs)
    .set({ status: 'CANCELLED', finishedAt: sql`now()`, lockedBy: null, lockedAt: null, error: { code: 'CANCELLED', message: 'Cancelled by user' } })
    .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, workerId)));
}

/**
 * Request cancellation. A queued job is cancelled immediately; a running job is flagged
 * and stops at its next stage boundary. Returns the job's status after the request.
 */
export async function requestJobCancel(ex: Executor, jobId: string): Promise<Job['status'] | null> {
  const [queued] = await ex
    .update(jobs)
    .set({ status: 'CANCELLED', cancelRequested: true, finishedAt: sql`now()`, error: { code: 'CANCELLED', message: 'Cancelled by user' } })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'QUEUED')))
    .returning({ status: jobs.status });
  if (queued) return queued.status;
  const [running] = await ex
    .update(jobs)
    .set({ cancelRequested: true })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'RUNNING')))
    .returning({ status: jobs.status });
  if (running) return running.status;
  const [current] = await ex.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId));
  return current?.status ?? null;
}

/**
 * Re-queue (or fail, when attempts are exhausted) jobs whose worker stopped heart-beating.
 * Returns the jobs that were transitioned so callers can reconcile domain state.
 */
export async function reapStaleJobs(db: Database, staleAfterMs: number): Promise<Pick<Job, 'id' | 'type' | 'status' | 'versionId'>[]> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  return db
    .update(jobs)
    .set({
      status: sql`CASE WHEN ${jobs.attempts} >= ${jobs.maxAttempts} THEN 'FAILED'::job_status ELSE 'QUEUED'::job_status END`,
      lockedBy: null,
      lockedAt: null,
      finishedAt: sql`CASE WHEN ${jobs.attempts} >= ${jobs.maxAttempts} THEN now() ELSE NULL END`,
      error: { code: 'WORKER_LOST', message: 'The worker processing this job stopped responding.', retryable: true },
    })
    .where(and(eq(jobs.status, 'RUNNING'), lt(jobs.heartbeatAt, cutoff)))
    .returning({ id: jobs.id, type: jobs.type, status: jobs.status, versionId: jobs.versionId });
}

export async function getJobs(db: Database, ids: string[]): Promise<Job[]> {
  if (ids.length === 0) return [];
  return db.select().from(jobs).where(inArray(jobs.id, ids));
}

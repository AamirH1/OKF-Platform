import { hostname } from 'node:os';
import {
  and,
  auditLogs,
  claimJob,
  completeJob,
  datasetVersions,
  eq,
  failJob,
  heartbeatJob,
  type Job,
  type JobType,
  jobs,
  LostJobLockError,
  lt,
  markJobCancelled,
  reapStaleJobs,
  refreshDatasetStatus,
  uploads,
} from '@okf/db';
import { JobCancelledError, type JobContext, JobFailure, type JobHandler, type WorkerDeps } from './context';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls the Postgres job queue with `concurrency` independent loops. Each job gets a
 * heartbeat timer; a reaper re-queues jobs from crashed workers (ADR-0002).
 */
export class Runner {
  readonly workerId = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  private running = false;
  private loops: Promise<void>[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly deps: WorkerDeps,
    private readonly handlers: Partial<Record<JobType, JobHandler>>,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const { env } = this.deps;
    for (let i = 0; i < Math.max(1, env.WORKER_CONCURRENCY); i++) this.loops.push(this.loop());
    this.timers.push(setInterval(() => void this.maintenance(), Math.max(10_000, env.WORKER_STALE_AFTER_MS / 2)));
    this.deps.log.info({ workerId: this.workerId, concurrency: env.WORKER_CONCURRENCY }, 'worker started');
  }

  /** Stop claiming new jobs and wait for in-flight jobs to finish. */
  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    await Promise.all(this.loops);
  }

  private async loop(): Promise<void> {
    const types = Object.keys(this.handlers) as JobType[];
    while (this.running) {
      let job: Job | null = null;
      try {
        job = await claimJob(this.deps.db, this.workerId, types);
      } catch (err) {
        this.deps.log.error({ err }, 'claim failed');
      }
      if (!job) {
        await sleep(this.deps.env.WORKER_POLL_INTERVAL_MS);
        continue;
      }
      await this.execute(job);
    }
  }

  /** Run exactly one job to completion. Public so tests can drive the pipeline deterministically. */
  async execute(job: Job): Promise<void> {
    const { db, log: baseLog, metrics } = this.deps;
    const handler = this.handlers[job.type as JobType];
    const log = baseLog.child({ jobId: job.id, jobType: job.type, versionId: job.versionId, attempt: job.attempts });
    const started = performance.now();
    let cancelled = false;
    let lostLock = false;
    let lastStage = job.stage ?? 'start';
    const beat = async (update: { stage?: string; progress?: number } = {}) => {
      try {
        const r = await heartbeatJob(db, job.id, this.workerId, update);
        if (r.cancelRequested) cancelled = true;
      } catch (err) {
        if (err instanceof LostJobLockError) lostLock = true;
        else log.warn({ err }, 'heartbeat failed');
      }
    };
    const timer = setInterval(() => void beat(), this.deps.env.WORKER_HEARTBEAT_MS);
    const ctx: JobContext = {
      job,
      log,
      progress: async (stage, percent) => {
        lastStage = stage;
        await beat({ stage, progress: percent });
        if (lostLock) throw new Error('Lost job lock; another worker owns this job now.');
        if (cancelled) throw new JobCancelledError();
      },
    };

    metrics.activeJobs.inc();
    log.info('job started');
    try {
      if (!handler) throw new JobFailure('UNKNOWN_JOB_TYPE', `No handler for job type ${job.type}`);
      const result = await handler.run(ctx);
      await completeJob(db, job.id, this.workerId, result ?? null);
      metrics.jobDuration.labels(job.type, 'completed').observe((performance.now() - started) / 1000);
      log.info({ durationMs: Math.round(performance.now() - started) }, 'job completed');
    } catch (err) {
      if (lostLock || err instanceof LostJobLockError) {
        log.warn('job lock lost; abandoning without state changes');
        return;
      }
      if (err instanceof JobCancelledError) {
        await markJobCancelled(db, job.id, this.workerId);
        await handler?.onTerminalFailure?.(job, { code: 'CANCELLED', message: 'Processing was cancelled.', stage: lastStage });
        metrics.jobDuration.labels(job.type, 'cancelled').observe((performance.now() - started) / 1000);
        log.info('job cancelled');
        return;
      }
      const failure =
        err instanceof JobFailure
          ? { code: err.code, message: err.message, stage: err.stage ?? lastStage, retryable: err.retryable }
          : { code: 'INTERNAL_ERROR', message: 'Processing failed due to an internal error; it will be retried.', stage: lastStage, retryable: true };
      if (!(err instanceof JobFailure)) log.error({ err }, 'job error');
      else log.warn({ code: err.code, stage: failure.stage }, err.message);
      metrics.jobFailures.labels(job.type, failure.code).inc();
      try {
        const outcome = await failJob(db, job, this.workerId, failure);
        if (outcome === 'failed') {
          const terminal = failure.retryable ? { ...failure, message: `${failure.message.replace(/ it will be retried\.$/, '')} Gave up after ${job.attempts} attempts.` } : failure;
          await handler?.onTerminalFailure?.(job, { code: terminal.code, message: terminal.message, stage: terminal.stage });
          metrics.jobDuration.labels(job.type, 'failed').observe((performance.now() - started) / 1000);
        }
      } catch (e) {
        log.error({ err: e }, 'failed to record job failure');
      }
    } finally {
      clearInterval(timer);
      metrics.activeJobs.dec();
    }
  }

  /** Reap jobs from dead workers and expire abandoned multipart uploads. */
  async maintenance(): Promise<void> {
    const { db, storage, log, env } = this.deps;
    try {
      const reaped = await reapStaleJobs(db, env.WORKER_STALE_AFTER_MS);
      for (const j of reaped) {
        log.warn({ jobId: j.id, status: j.status }, 'reaped stale job');
        if (j.status === 'FAILED') {
          const [job] = await db.select().from(jobs).where(eq(jobs.id, j.id));
          if (job) await this.handlers[job.type as JobType]?.onTerminalFailure?.(job, { code: 'WORKER_LOST', message: 'The worker processing this version stopped responding too many times.', stage: job.stage });
        }
      }
      const expired = await db.select().from(uploads).where(and(eq(uploads.status, 'INITIATED'), lt(uploads.expiresAt, new Date()))).limit(100);
      for (const up of expired) {
        await storage.abortMultipartUpload(up.storageKey, up.s3UploadId).catch((err: unknown) => log.warn({ err, uploadId: up.id }, 'abort failed'));
        await db.update(uploads).set({ status: 'EXPIRED' }).where(eq(uploads.id, up.id));
      }
    } catch (err) {
      log.error({ err }, 'maintenance failed');
    }
  }
}

/** Mark an ingesting version FAILED (used by the ingest handler and the reaper). */
export async function failVersion(deps: WorkerDeps, job: Job, failure: { code: string; message: string; stage: string | null }): Promise<void> {
  if (!job.versionId || !job.datasetId) return;
  await deps.db.transaction(async (tx) => {
    const [v] = await tx
      .update(datasetVersions)
      .set({ status: 'FAILED', failure, processedAt: new Date(), ...(failure.code === 'MALWARE_DETECTED' ? { scanStatus: 'infected' as const } : {}) })
      .where(and(eq(datasetVersions.id, job.versionId!), eq(datasetVersions.status, 'PROCESSING')))
      .returning();
    if (!v) return;
    await refreshDatasetStatus(tx, job.datasetId!);
    await tx.insert(auditLogs).values({
      organizationId: job.organizationId,
      actorType: 'system',
      action: 'version.failed',
      resourceType: 'dataset',
      resourceId: job.datasetId,
      metadata: { version: v.number, versionId: v.id, jobId: job.id, ...failure },
    });
  });
}

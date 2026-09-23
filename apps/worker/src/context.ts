import type { MalwareScanner } from '@okf/archive';
import type { Env } from '@okf/config';
import type { Database, Job } from '@okf/db';
import type { ObjectStorage } from '@okf/storage';
import type { Logger } from 'pino';
import type { WorkerMetrics } from './metrics';

export interface WorkerDeps {
  env: Env;
  db: Database;
  storage: ObjectStorage;
  scanner: MalwareScanner;
  log: Logger;
  metrics: WorkerMetrics;
  now?: () => Date;
}

export interface JobContext {
  job: Job;
  log: Logger;
  /** Report progress; throws `JobCancelledError` if cancellation was requested. */
  progress(stage: string, percent: number): Promise<void>;
}

/** An expected, user-facing failure. Non-retryable unless stated. */
export class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stage: string | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'JobFailure';
  }
}

export class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled');
    this.name = 'JobCancelledError';
  }
}

export interface JobHandler {
  run(ctx: JobContext): Promise<unknown>;
  /** Reconcile domain state after a terminal failure or cancellation (e.g. mark the version FAILED). */
  onTerminalFailure?(job: Job, failure: { code: string; message: string; stage: string | null }): Promise<void>;
}

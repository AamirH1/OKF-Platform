import type { JobType } from '@okf/db';
import type { JobHandler, WorkerDeps } from './context';
import { diffHandler } from './pipeline/diff';
import { ingestHandler } from './pipeline/ingest';
import { purgeHandler } from './pipeline/purge';
import { Runner } from './runner';

export { Runner } from './runner';
export * from './context';
export { createWorkerMetrics } from './metrics';

export function createHandlers(deps: WorkerDeps): Record<JobType, JobHandler> {
  return {
    ingest_version: ingestHandler(deps),
    diff_versions: diffHandler(deps),
    purge_dataset: purgeHandler(deps),
  };
}

export function createRunner(deps: WorkerDeps): Runner {
  return new Runner(deps, createHandlers(deps));
}

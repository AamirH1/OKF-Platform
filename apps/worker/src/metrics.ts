import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

export function createWorkerMetrics() {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'okf-worker' });
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    jobDuration: new Histogram({
      name: 'okf_job_duration_seconds',
      help: 'Job processing duration by type and outcome',
      labelNames: ['type', 'outcome'] as const,
      buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800],
      registers: [registry],
    }),
    stageDuration: new Histogram({
      name: 'okf_ingest_stage_duration_seconds',
      help: 'Ingestion stage duration',
      labelNames: ['stage'] as const,
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300],
      registers: [registry],
    }),
    jobFailures: new Counter({ name: 'okf_job_failures_total', help: 'Job failures by type and code', labelNames: ['type', 'code'] as const, registers: [registry] }),
    validationFailures: new Counter({ name: 'okf_validation_nonconformant_total', help: 'Versions failing OKF conformance', registers: [registry] }),
    storageErrors: new Counter({ name: 'okf_worker_storage_errors_total', help: 'Object storage errors in the worker', registers: [registry] }),
    activeJobs: new Gauge({ name: 'okf_worker_active_jobs', help: 'Jobs currently running in this worker', registers: [registry] }),
  };
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>;

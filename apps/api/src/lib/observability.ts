import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';

/**
 * Hook for an external error tracker (Sentry, Cloud Error Reporting, …). The default
 * implementation only logs; wire a real client in `server.ts` without touching call sites.
 */
export interface ErrorReporter {
  capture(err: unknown, context?: Record<string, unknown>): void;
}

export const loggingReporter = (log: { error: (obj: object, msg: string) => void }): ErrorReporter => ({
  capture: (err, context) => log.error({ err, ...context }, 'error reported'),
});

export function createMetrics() {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'okf-api' });
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    httpDuration: new Histogram({
      name: 'okf_http_request_duration_seconds',
      help: 'API latency by route',
      labelNames: ['method', 'route', 'status'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    uploadsInitiated: new Counter({ name: 'okf_uploads_initiated_total', help: 'Upload sessions created', registers: [registry] }),
    uploadFailures: new Counter({
      name: 'okf_upload_failures_total',
      help: 'Upload completion failures by reason',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    queries: new Counter({
      name: 'okf_queries_total',
      help: 'Dataset queries by mode and outcome',
      labelNames: ['mode', 'outcome'] as const,
      registers: [registry],
    }),
    storageErrors: new Counter({ name: 'okf_storage_errors_total', help: 'Object storage errors', labelNames: ['operation'] as const, registers: [registry] }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

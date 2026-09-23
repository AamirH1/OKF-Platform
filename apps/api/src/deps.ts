import type { Env } from '@okf/config';
import type { Database } from '@okf/db';
import type { QueryEngine } from '@okf/query';
import type { ObjectStorage } from '@okf/storage';
import type { Redis } from 'ioredis';
import type { ErrorReporter, Metrics } from './lib/observability';
import type { Mailer } from './lib/mailer';
import type { SearchProvider } from './services/search';

/** Everything the API needs from the outside world; injected so tests can substitute pieces. */
export interface AppDeps {
  env: Env;
  db: Database;
  storage: ObjectStorage;
  /** Null disables the shared rate-limit store (in-memory per process); used in tests. */
  redis: Redis | null;
  query: QueryEngine;
  mailer: Mailer;
  metrics: Metrics;
  reporter: ErrorReporter;
  search: SearchProvider;
}

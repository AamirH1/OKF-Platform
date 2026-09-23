import path from 'node:path';
import { Redis } from 'ioredis';
import pino from 'pino';
import { loadEnv } from '@okf/config';
import { createDb } from '@okf/db';
import { DuckDbQueryEngine } from '@okf/query';
import { createStorage } from '@okf/storage';
import { buildApp } from './app';
import { SmtpMailer } from './lib/mailer';
import { createMetrics, loggingReporter } from './lib/observability';
import { createArtifactLoader } from './services/artifacts';
import { PostgresSearchProvider } from './services/search';

async function main(): Promise<void> {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, base: { service: 'okf-api' } });
  const db = createDb(env.DATABASE_URL, env.DATABASE_POOL_MAX);
  const storage = createStorage(env);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  redis.on('error', (err) => log.warn({ err: err.message }, 'redis error'));
  const query = new DuckDbQueryEngine({
    loadArtifacts: createArtifactLoader(storage, path.resolve(env.QUERY_CACHE_DIR)),
    timeoutMs: env.QUERY_TIMEOUT_MS,
    maxRows: env.QUERY_MAX_ROWS,
    memoryLimit: env.QUERY_MEMORY_LIMIT,
    cacheEntries: env.QUERY_CACHE_ENTRIES,
  });

  const app = await buildApp({
    env,
    db: db.db,
    storage,
    redis,
    query,
    mailer: new SmtpMailer(env.SMTP_URL, env.MAIL_FROM),
    metrics: createMetrics(),
    reporter: loggingReporter(log),
    search: new PostgresSearchProvider(db.db),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000).unref();
    try {
      await app.close();
      await query.close();
      await db.close();
      redis.disconnect();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

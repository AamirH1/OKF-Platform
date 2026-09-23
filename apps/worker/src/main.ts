import http from 'node:http';
import pino from 'pino';
import { createScanner } from '@okf/archive';
import { loadEnv } from '@okf/config';
import { createDb, sql } from '@okf/db';
import { createStorage } from '@okf/storage';
import { createRunner, createWorkerMetrics } from './index';

async function main(): Promise<void> {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, base: { service: 'okf-worker' } });
  const db = createDb(env.DATABASE_URL, Math.max(4, env.WORKER_CONCURRENCY * 2), 0);
  const storage = createStorage(env);
  const scanner = createScanner(env.MALWARE_SCANNER, env.CLAMAV_HOST, env.CLAMAV_PORT);
  const metrics = createWorkerMetrics();
  if (scanner.name === 'clamav' && !(await scanner.ping())) log.warn('ClamAV is not reachable yet; scans will be retried');
  if (scanner.name === 'none') log.warn('MALWARE_SCANNER=none: uploads are not malware-scanned (recorded as "skipped")');

  const runner = createRunner({ env, db: db.db, storage, scanner, log, metrics });
  runner.start();

  // Small HTTP server for orchestration probes and Prometheus scraping.
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.url === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      if (req.url === '/ready') {
        try {
          await db.db.execute(sql`SELECT 1`);
          await storage.ping();
          return res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ready"}');
        } catch (e) {
          return res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'not_ready', error: (e as Error).message }));
        }
      }
      if (req.url === '/metrics') {
        if (env.METRICS_TOKEN && req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) return res.writeHead(401).end();
        return res.writeHead(200, { 'content-type': metrics.registry.contentType }).end(await metrics.registry.metrics());
      }
      res.writeHead(404).end();
    })();
  });
  server.listen(env.WORKER_HTTP_PORT, () => log.info({ port: env.WORKER_HTTP_PORT }, 'worker probes listening'));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'draining in-flight jobs');
    // Jobs still running after the grace period are re-queued by another worker's reaper.
    const force = setTimeout(() => process.exit(1), 60_000).unref();
    await runner.stop();
    server.close();
    await db.close();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

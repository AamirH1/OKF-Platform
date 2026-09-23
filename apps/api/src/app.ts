import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, jsonSchemaTransformObject, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from '@okf/db';
import type { AppDeps } from './deps';
import { registerErrorHandler } from './lib/errors';
import authPlugin from './plugins/auth';
import apiKeyRoutes from './routes/api-keys';
import auditRoutes from './routes/audit';
import authRoutes from './routes/auth';
import conceptRoutes from './routes/concepts';
import datasetRoutes from './routes/datasets';
import jobRoutes from './routes/jobs';
import organizationRoutes from './routes/organizations';
import queryRoutes from './routes/query';
import searchRoutes from './routes/search';
import sharingRoutes from './routes/sharing';
import uploadRoutes from './routes/uploads';
import userRoutes from './routes/users';
import versionRoutes from './routes/versions';

export type { AppDeps } from './deps';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env } = deps;
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers["x-share-token"]', 'res.headers["set-cookie"]'], censor: '[redacted]' },
    },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQUEST_ID.test(h) ? h : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app, deps.reporter);

  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    deps.metrics.httpDuration
      .labels(req.method, req.routeOptions.url ?? 'unmatched', String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
  });

  await app.register(helmet, {
    // JSON API: no documents are rendered, so lock the CSP down completely.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: [env.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id', 'x-share-token', 'authorization'],
    exposedHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(authPlugin, { deps });
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // Runs after authentication so limits apply per API key / user, falling back to IP.
    hook: 'preHandler',
    keyGenerator: (req) => (req.auth?.apiKey ? `key:${req.auth.apiKey.id}` : req.auth?.user ? `user:${req.auth.user.id}` : `ip:${req.ip}`),
    ...(deps.redis ? { redis: deps.redis, nameSpace: 'okf-rl:' } : {}),
    skipOnError: true,
    allowList: (req) => req.url === '/health' || req.url === '/ready',
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'OKF Platform API',
        version: '1.0.0',
        description:
          'Catalog, validate, version, query and share Open Knowledge Format (OKF v0.2) bundles.\n\n' +
          'Authentication: browser sessions use the `okf_session` cookie plus an `x-csrf-token` header on mutating requests; ' +
          'programmatic clients send `Authorization: Bearer okf_…` API keys. Errors use `{ "error": { "code", "message", "requestId" } }`. ' +
          `Rate limit: ${env.RATE_LIMIT_MAX} requests per ${env.RATE_LIMIT_WINDOW_MS / 1000}s per API key/user/IP (${env.AUTH_RATE_LIMIT_MAX} for auth endpoints); ` +
          'exceeding it returns 429 with `retry-after` and `x-ratelimit-*` headers.',
        license: { name: 'Apache-2.0' },
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key: `okf_<id>_<secret>`' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'okf_session' },
          csrfToken: { type: 'apiKey', in: 'header', name: 'x-csrf-token' },
        },
      },
      security: [{ bearerAuth: [] }, { cookieAuth: [], csrfToken: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/ready', { schema: { hide: true } }, async (_req, reply) => {
    const checks: Record<string, 'ok' | string> = {};
    const run = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
        checks[name] = 'ok';
      } catch (e) {
        checks[name] = e instanceof Error ? e.message.slice(0, 200) : 'error';
      }
    };
    await Promise.all([
      run('database', () => deps.db.execute(sql`SELECT 1`)),
      run('storage', () => deps.storage.ping()),
      ...(deps.redis ? [run('redis', () => deps.redis!.ping())] : []),
    ]);
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', checks });
  });
  app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
    if (env.METRICS_TOKEN && req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Metrics token required.', requestId: req.id } });
    }
    return reply.header('content-type', deps.metrics.registry.contentType).send(await deps.metrics.registry.metrics());
  });

  await app.register(
    async (v1) => {
      v1.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
      for (const routes of [
        authRoutes,
        userRoutes,
        organizationRoutes,
        apiKeyRoutes,
        auditRoutes,
        datasetRoutes,
        versionRoutes,
        uploadRoutes,
        conceptRoutes,
        queryRoutes,
        searchRoutes,
        sharingRoutes,
        jobRoutes,
      ]) {
        await v1.register(routes, { deps });
      }
    },
    { prefix: '/api/v1' },
  );

  return app;
}

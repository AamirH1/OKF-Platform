import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .transform((v) => v === 'true' || v === '1');

const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/**
 * Every environment variable the API and worker read. Documented in `.env.example`.
 * Parsing fails fast at startup with a readable message instead of failing later.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: int(4000),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  TRUST_PROXY: bool.default(false),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: int(10),
  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().default(''),
  S3_PUBLIC_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default(true),

  SESSION_TTL_HOURS: int(24 * 7),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),

  SMTP_URL: z.string().default('smtp://localhost:1025'),
  MAIL_FROM: z.string().default('OKF Platform <no-reply@okf.local>'),

  UPLOAD_MAX_BYTES: int(1024 * 1024 * 1024),
  UPLOAD_PART_SIZE_BYTES: int(8 * 1024 * 1024).refine((n) => n >= 5 * 1024 * 1024, {
    message: 'S3 multipart parts must be at least 5 MiB',
  }),
  UPLOAD_SESSION_TTL_HOURS: int(24),

  EXTRACT_MAX_FILES: int(20_000),
  EXTRACT_MAX_TOTAL_BYTES: int(2 * 1024 * 1024 * 1024),
  EXTRACT_MAX_FILE_BYTES: int(50 * 1024 * 1024),
  EXTRACT_MAX_RATIO: int(200),
  EXTRACT_MAX_DEPTH: int(32),

  MALWARE_SCANNER: z.enum(['none', 'clamav']).default('none'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: int(3310),

  IMPORT_ALLOWED_HOSTS: csv,
  IMPORT_ALLOW_HTTP: bool.default(false),
  IMPORT_ALLOW_PRIVATE_NETWORKS: bool.default(false),
  IMPORT_MAX_BYTES: int(512 * 1024 * 1024),
  IMPORT_TIMEOUT_MS: int(120_000),

  QUERY_CACHE_DIR: z.string().default('.cache/query'),
  QUERY_TIMEOUT_MS: int(5_000),
  QUERY_MAX_ROWS: int(1_000),
  QUERY_MEMORY_LIMIT: z.string().default('512MB'),
  QUERY_CACHE_ENTRIES: int(16),

  WORKER_CONCURRENCY: int(2),
  WORKER_POLL_INTERVAL_MS: int(1_000),
  WORKER_TEMP_DIR: z.string().default(''),
  WORKER_HEARTBEAT_MS: int(5_000),
  WORKER_STALE_AFTER_MS: int(60_000),
  WORKER_HTTP_PORT: int(4100),

  RATE_LIMIT_MAX: int(300),
  RATE_LIMIT_WINDOW_MS: int(60_000),
  AUTH_RATE_LIMIT_MAX: int(10),

  METRICS_TOKEN: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

export function cookieSecure(env: Env): boolean {
  if (env.COOKIE_SECURE === 'auto') return env.NODE_ENV === 'production';
  return env.COOKIE_SECURE === 'true';
}

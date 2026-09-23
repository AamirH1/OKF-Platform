import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Integration tests run against the docker compose services but never the dev
 * database or bucket: DATABASE_URL and S3_BUCKET are redirected to test resources.
 */
const root = path.resolve(import.meta.dirname, '../..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
else if (existsSync(path.join(root, '.env.example'))) process.loadEnvFile(path.join(root, '.env.example'));

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://okf:okf@localhost:5432/okf_test';
if (!process.env.S3_BUCKET?.endsWith('-test')) process.env.S3_BUCKET = `${process.env.S3_BUCKET ?? 'okf-datasets'}-test`;
process.env.QUERY_CACHE_DIR = path.join(root, '.cache/query-test');

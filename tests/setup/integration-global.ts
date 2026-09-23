import { existsSync } from 'node:fs';
import path from 'node:path';

/** Runs once before all integration suites: migrates the dedicated test database. */
export default async function setup(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '../..');
  if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://okf:okf@localhost:5432/okf_test';
  if (!/okf_test/.test(url)) throw new Error(`Refusing to run integration tests against non-test database: ${url}`);
  const { runMigrations } = await import('@okf/db');
  await runMigrations(url);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';

/** `migrations/` next to `src/` in the repo, or next to `dist/` in the API image. */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Apply all pending migrations. Safe to run concurrently: drizzle takes an advisory lock. */
export async function runMigrations(url: string, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  const handle = createDb(url, 1, 0);
  try {
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await handle.close();
  }
}

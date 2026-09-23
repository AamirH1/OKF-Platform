export * from './schema';
export * from './client';
export * from './queue';
export { runMigrations, MIGRATIONS_DIR } from './migrate';
export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

/** Postgres error helpers (node-postgres surfaces SQLSTATE in `code`, possibly wrapped in `cause`). */
export function pgErrorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 3 && cur; i++) {
    if (typeof cur === 'object' && cur !== null && 'code' in cur && typeof (cur as { code: unknown }).code === 'string') {
      const code = (cur as { code: string }).code;
      if (/^[0-9A-Z]{5}$/.test(code)) return code;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

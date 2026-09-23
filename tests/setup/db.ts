import { type Database, sql } from '@okf/db';

/** Truncate every application table in the test database. */
export async function resetDatabase(db: Database): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('okf_test')) throw new Error('resetDatabase refused: not the test database');
  await db.execute(sql`
    DO $$ DECLARE r record; BEGIN
      SET LOCAL okf.allow_purge = 'on';
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;`);
}

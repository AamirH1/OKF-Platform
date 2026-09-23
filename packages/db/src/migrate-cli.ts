// CLI entry: `npm run db:migrate` locally, `node dist/migrate.js` in the API image.
// Kept separate from migrate.ts so bundling @okf/db into a service never triggers it.
import { runMigrations } from './migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
runMigrations(url)
  .then(() => console.warn('migrations applied'))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });

---
name: okf-repo-map
description: Map of the OKF platform monorepo — where each concern lives, key entry points, conventions and gotchas. Read this before exploring the codebase (instead of listing/grepping directories) when starting any task in this repo.
---

# OKF platform — repo map

Modular monolith: `apps/api` (Fastify) + `apps/worker` (job runner) + `apps/web` (Next.js),
shared `packages/*`. Workspace packages export TypeScript source directly (`exports: ./src/index.ts`);
no build step in dev (tsx / Next transpile). Import packages as `@okf/<name>`.

| Concern | Location |
|---|---|
| OKF parse/validate/profile/diff (pure) | `packages/okf/src` — `analyze.ts` orchestrates; `concept.ts` field rules; `markdown.ts` schema extraction; `diff.ts` |
| Archive safety + ClamAV | `packages/archive/src/extract.ts`, `scanner.ts` |
| DB schema / migrations / queue | `packages/db/src/schema.ts`, `packages/db/migrations/*.sql`, `queue.ts` |
| S3 storage + key layout | `packages/storage/src/index.ts` (`storageKeys`) |
| DuckDB query engine + parquet | `packages/query/src/engine.ts`, `artifacts.ts`, `tables.ts` (column whitelist) |
| RBAC (single source), zod request schemas, DTO types | `packages/shared/src/permissions.ts`, `schemas.ts`, `types.ts` |
| Env config (all vars) | `packages/config/src/index.ts`, documented in `.env.example` |
| API routes | `apps/api/src/routes/*.ts`; app wiring `apps/api/src/app.ts`; auth/CSRF `plugins/auth.ts` |
| Worker pipeline | `apps/worker/src/pipeline/*.ts`; loop `apps/worker/src/runner.ts` |
| Web pages | `apps/web/src/app/**/page.tsx`; API client `apps/web/src/lib/api.ts` |
| Fixtures | `tests/fixtures/okf/*` (Google samples vendored under Apache-2.0) |
| Docs / ADRs | `docs/*.md`, `docs/decisions/*.md` |

## Conventions
- Dataset = versioned OKF bundle; record = concept (ADR-0001). Never invent OKF fields — see `okf-spec` skill.
- Structural (§11) issues → `valid=false`; quality issues never affect validity (ADR-0003).
- All authorization via `canDataset`/`canOrg` in the API; web only hides controls.
- Processed versions are immutable (DB triggers in `migrations/0001_*`); purge needs `SET LOCAL okf.allow_purge='on'`.
- Jobs: insert via `enqueueJob(tx, …)` in the same transaction as the domain change (ADR-0002).
- Schema change: edit `schema.ts` → `npm run db:generate` → review SQL → `npm run db:migrate`.

## Local ports on this machine (see `.env`)
Postgres 5433 (native PG owns 5432), Redis 6380, MinIO 9000/9001, Mailpit 1025/8025, API 4000, web 3000.

## Verify
Use the `okf-check` skill (`bash scripts/check.sh`), not raw tsc/eslint/vitest.

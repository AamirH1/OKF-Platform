# OKF Platform

Catalog, validate, version, query and share **Open Knowledge Format (OKF v0.2)** bundles.
OKF is a knowledge format (markdown concepts + YAML frontmatter), not tabular data — a
dataset here is a versioned OKF bundle and each concept is a record ([research](docs/okf-research.md), [ADR-0001](docs/decisions/0001-dataset-is-an-okf-bundle.md)).

**Stack:** TypeScript monorepo · Next.js 16 web · Fastify API · Postgres job-queue worker ·
PostgreSQL 17 · S3/MinIO · Redis (rate limits) · DuckDB (queries). See [architecture](docs/architecture.md).

## Quick start
Requirements: Node ≥ 22.12 (24 recommended), Docker.
```bash
npm install
docker compose up -d          # postgres, redis, minio (+bucket), mailpit
npm run dev                   # creates .env if missing, migrates, runs api+worker+web
npm run db:seed               # optional demo data (demo@okf.local / "demo password for okf")
```
Web http://localhost:3000 · API http://localhost:4000 (`/api/v1/openapi.json`) · MinIO console :9001 · Mailpit (reset emails) :8025.
Ports clash with local services? Set `POSTGRES_PORT`/`REDIS_PORT` etc. in `.env` and update the matching URLs.

## Commands
| | |
|---|---|
| `npm run dev` / `dev:api` / `dev:worker` / `dev:web` | run services |
| `npm run check` | typecheck + lint + unit tests (quiet) |
| `npm test` · `npm run test:integration` · `npm run test:e2e` | unit · integration (needs compose) · Playwright |
| `npm run db:generate` / `db:migrate` | new migration from schema / apply |
| `npm run openapi` | regenerate [docs/openapi.yaml](docs/openapi.yaml) |
| `npm run fixtures:large -- 20000 --tar` | generate a large bundle |

## Environment
Every variable is documented in [.env.example](.env.example) (database, Redis, S3, SMTP, upload/extraction limits, ClamAV, import SSRF policy, query limits, worker, rate limits, metrics).

## Docs
[OKF research](docs/okf-research.md) · [Architecture](docs/architecture.md) · [API](docs/api.md) · [Database](docs/database.md) · [Security](docs/security.md) · [Deployment](docs/deployment.md) · [Decisions](docs/decisions/)

## Troubleshooting
- `role "okf" does not exist` → another Postgres owns 5432; set `POSTGRES_PORT=5433` and fix `DATABASE_URL`.
- Upload fails with "ETag" → bucket CORS must allow PUT from `WEB_ORIGIN` and expose `ETag` (`MINIO_API_CORS_ALLOW_ORIGIN`).
- Version stuck PROCESSING → is the worker running? Check `http://localhost:4100/ready`.

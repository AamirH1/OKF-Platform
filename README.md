<div align="center">

# OKF Platform

**Catalog, validate, version, query and share [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) bundles.**

![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6)
![Node](https://img.shields.io/badge/Node-%E2%89%A522.12-339933)
![Next.js](https://img.shields.io/badge/Next.js-16-000000)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169e1)
![OKF](https://img.shields.io/badge/OKF-v0.2-6b7280)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

</div>

---

OKF Platform is a full-stack data catalog for **OKF knowledge bundles**. You upload a bundle, and
a background pipeline scans, extracts, validates, profiles and indexes it. Each upload becomes an
immutable version that you can browse, search, query with SQL, compare, publish and share through
the UI or a REST API.

> **What is OKF?** The Open Knowledge Format (v0.2, Apache-2.0) is a vendor-neutral format for
> *knowledge about data*: a directory of Markdown files ("concepts") with YAML frontmatter, where
> `type` is the only required field. It is **not** a tabular data format. On this platform, a
> **dataset is a versioned OKF bundle** and each **concept is a record**. See
> [docs/okf-research.md](docs/okf-research.md) and [ADR-0001](docs/decisions/0001-dataset-is-an-okf-bundle.md).

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Project structure](#project-structure)
- [Development](#development)
- [Testing](#testing)
- [Using the API](#using-the-api)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Security](#security)
- [Performance](#performance)
- [Limitations and roadmap](#limitations-and-roadmap)
- [Documentation](#documentation)
- [License](#license)

## Features

| Area | What you get |
|---|---|
| **Ingestion** | Drag-and-drop upload that goes straight to object storage (multipart, progress, cancel, retry, resume) or import from a URL. `.zip`, `.tar.gz`, `.tar` and single `.md` files are accepted. |
| **Pipeline** | fetch → malware scan (ClamAV) → type detection → safe extraction → OKF detection → parse → validate → profile → store → materialize → index, run asynchronously with live progress and cancellation. |
| **Validation** | OKF §11 **structural conformance** (decides validity), kept separate from **quality checks** (broken links, staleness, missing descriptions and more). Every finding has a code, severity, file and line. |
| **Catalog** | Dataset pages with Overview, Data Preview, Schema, Metadata, Validation, Versions, Query, Activity and Sharing tabs. A concept graph and a rendered concept view with provenance and trust info. |
| **Schema** | Frontmatter field schema inferred across concepts, plus asset schemas parsed from `# Schema` tables and lists. |
| **Query** | A visual query builder and read-only SQL, running on DuckDB in a sandbox. CSV export. |
| **Versions** | Immutable versions (enforced by database triggers), SHA-256 checksums, and version diffs that separate **exact** per-concept changes from **aggregate** statistics. |
| **Search** | Full-text search over names, descriptions, tags, concept types and titles, bodies and column names, with visibility rules applied before pagination. |
| **Collaboration** | Organizations, invitations, Owner/Admin/Editor/Viewer roles, private/organization/public visibility, per-user grants and expiring share links. |
| **API** | Versioned REST API (`/api/v1`) with a generated OpenAPI 3.1 spec, scoped hashed API keys, rate limits and an audit log. |
| **Operations** | Structured logs with request and job IDs, Prometheus metrics, `/health` and `/ready`, Docker images, and CI. |

## Architecture

```
            Browser ── same-origin /api rewrite ──┐          presigned multipart PUT
               │                                  ▼                     │
        Next.js 16 web                    Fastify API (/api/v1) ───────►│ Object storage
                                          RBAC · OpenAPI · DuckDB       │ (MinIO / S3 / GCS)
                                              │      │                  ▲
                                              ▼      ▼                  │
                                       PostgreSQL  Redis          Worker (ingest, diff, purge)
                                   metadata · FTS  rate limits    polls jobs FOR UPDATE SKIP LOCKED
                                   jobs · audit
```

This is a modular monolith plus a worker, with no microservices. Key decisions:
[Postgres job queue](docs/decisions/0002-postgres-job-queue.md) ·
[validation layers](docs/decisions/0003-validation-layers.md) ·
[DuckDB query engine](docs/decisions/0004-duckdb-query-engine.md) ·
[direct-to-storage uploads](docs/decisions/0005-direct-to-storage-uploads.md) ·
[tech stack](docs/decisions/0006-stack.md). Full details are in [docs/architecture.md](docs/architecture.md).

**Stack:** TypeScript 6 · Next.js 16 / React 19 · Tailwind CSS 4 · TanStack Query · React Hook Form + Zod ·
Fastify 5 · Drizzle ORM · PostgreSQL 17 · Redis · S3 API · DuckDB · Vitest · Playwright.

## Quick start

**Requirements:** Node.js ≥ 22.12 (24 recommended) and Docker.

```bash
git clone <your-repo-url> okf-platform && cd okf-platform
npm install
docker compose up -d      # Postgres, Redis, MinIO (+ bucket), Mailpit
npm run dev               # creates .env if missing, runs migrations, starts api + worker + web
npm run db:seed           # optional: demo account and sample bundles (in a second terminal)
```

| Service | URL |
|---|---|
| Web app | http://localhost:3000 |
| API + OpenAPI | http://localhost:4000 · `/api/v1/openapi.json` |
| MinIO console | http://localhost:9001 (`okfminio` / `okfminio-secret`) |
| Mailpit (password-reset and invitation emails) | http://localhost:8025 |

The seeded demo login is `demo@okf.local` / `demo password for okf`.
To enable malware scanning locally, run `docker compose --profile security up -d` and set `MALWARE_SCANNER=clamav`.

## Project structure

```
apps/
  api/        Fastify REST API: routes, auth/CSRF, RBAC, services, OpenAPI generation
  worker/     Background jobs: ingestion pipeline, version diff, dataset purge
  web/        Next.js app (App Router)
packages/
  okf/        OKF engine: parse, validate, profile, diff (pure, no I/O besides reading)
  archive/    Safe extraction, malware-scanner client, SSRF-guarded URL fetch
  db/         Drizzle schema, SQL migrations, job queue, domain helpers
  storage/    S3-compatible storage client and key layout
  query/      QueryEngine interface + DuckDB implementation
  shared/     RBAC model, Zod request/response schemas shared by API and web
  config/     Zod-validated environment configuration
tests/
  fixtures/okf/   Google sample bundles + valid, invalid, malformed and edge-case bundles
  e2e/            Playwright browser tests
docs/         Research, architecture, API, database, security, deployment, ADRs
```

## Development

| Command | Purpose |
|---|---|
| `npm run dev` | Run API, worker and web together (prefixed logs) |
| `npm run dev:api` · `dev:worker` · `dev:web` | Run one service |
| `npm run check` | Typecheck + lint + unit tests, with one line of output per step |
| `npm run db:generate` | Create a migration from `packages/db/src/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Seed demo data through the API |
| `npm run openapi` | Regenerate [docs/openapi.yaml](docs/openapi.yaml) |
| `npm run fixtures:large -- 20000 --tar` | Generate a large synthetic bundle |
| `npm run build` | Bundle the API and worker, build the web app |

If ports clash with other local services, change `POSTGRES_PORT`, `REDIS_PORT` and so on in `.env`
and update the matching connection URLs.

## Testing

```bash
npm test                    # unit tests (engine, archive safety, RBAC matrix, query sandbox)
npm run test:integration    # API + worker + Postgres + MinIO (needs docker compose up -d)
npm run test:e2e            # Playwright: full acceptance flow in Chromium
OKF_PERF=1 npm run test:integration   # opt-in load measurement (5,000 concepts)
```

Coverage includes hostile archives (zip-slip, symlinks, bombs), SSRF targets, SQL sandbox escapes,
CSRF and origin enforcement, tenant isolation and immutability triggers. The E2E suite runs:
signup → organization → dataset → upload → validation → schema → preview → search → new version →
compare → publish → another user's access → API key → audit log.

## Using the API

Browser clients use a session cookie plus an `x-csrf-token` header. Programmatic clients use API
keys, created under **Settings → API keys**.

```bash
export OKF_KEY=okf_xxxxxxxx_...
curl -H "Authorization: Bearer $OKF_KEY" http://localhost:4000/api/v1/datasets

curl -H "Authorization: Bearer $OKF_KEY" -H 'content-type: application/json' \
  -d '{"sql":"SELECT type, count(*) AS n FROM concepts GROUP BY type"}' \
  http://localhost:4000/api/v1/datasets/$DATASET_ID/query/sql
```

Errors always have the shape `{"error": {"code", "message", "requestId"}}`. See
[docs/api.md](docs/api.md) and [docs/openapi.yaml](docs/openapi.yaml).

## Configuration

Every environment variable is documented in [.env.example](.env.example). It covers the database,
Redis, object storage, SMTP, upload and extraction limits, ClamAV, the URL-import SSRF policy, query
limits, worker tuning, rate limits and the metrics token. Configuration is validated at startup and
the process fails fast with a readable error.

## Deployment

One multi-target [Dockerfile](Dockerfile) produces the `api`, `worker` and `web` images (non-root,
with health checks). [docker-compose.prod.yml](docker-compose.prod.yml) runs the whole stack on a
single host, with migrations as a release step. A GCP guide (Cloud Run, Cloud SQL, Memorystore,
GCS) and notes on backups and scaling are in [docs/deployment.md](docs/deployment.md).
[CI](.github/workflows/ci.yml) runs lint, typecheck, unit, integration and E2E tests, an OpenAPI
drift check, a dependency audit and image builds.

## Security

- **Access control:** RBAC is enforced server-side on every route. Invisible resources return 404.
- **Credentials:** Argon2id password hashing. Sessions, API keys and share links are stored only as hashes.
- **Uploads:** content-sniffed, extracted in a sandbox with size, ratio and path limits, and malware scanning fails closed.
- **SSRF:** URL imports are checked at socket connect time.
- **SQL:** user SQL runs in DuckDB with no file or network access.
- **XSS:** uploaded Markdown is rendered without raw HTML, behind a strict CSP.

The full threat model and controls are in [docs/security.md](docs/security.md).

## Performance

These numbers were measured on a laptop with the included generator (`OKF_PERF=1`):

| 5,000-concept bundle (~10k links) | Time |
|---|---|
| Engine analysis (parse, validate, profile) | ~3.0 s |
| Full ingestion (upload → indexed and queryable) | ~9.5 s |
| Paginated preview · concept search | 36 ms · 61 ms |
| SQL query: cold · warm | 34 ms · 7 ms |

## Limitations and roadmap

- No MFA or email verification yet. The schema is ready for OAuth/OIDC providers.
- Previewing the *underlying* data a concept describes (e.g. a BigQuery table) is out of scope,
  because OKF describes data but doesn't contain it.
- A renamed file appears as a removal plus an addition in diffs, since OKF identity is the file path.
- The API and worker images can be slimmed further (they are currently pruned monorepo-wide).
- Planned: OAuth sign-in, OpenSearch backend, Knowledge Catalog export, attested-computation execution.

## Documentation

[OKF research](docs/okf-research.md) · [Architecture](docs/architecture.md) · [API](docs/api.md) ·
[Database](docs/database.md) · [Security](docs/security.md) · [Deployment](docs/deployment.md) ·
[Decision records](docs/decisions/)

## License

Apache License 2.0. The sample bundles in `tests/fixtures/okf/acme_retail` and `stackoverflow` are
© Google LLC, Apache-2.0 (see [NOTICE](tests/fixtures/okf/NOTICE)).

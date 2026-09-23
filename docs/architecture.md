# Architecture

OKF Platform is a **modular monolith plus a job worker**: one HTTP API
process, one (horizontally scalable) worker process, a Next.js frontend,
PostgreSQL, S3-compatible object storage, and Redis. Architectural decisions
are recorded in [`docs/decisions/`](decisions/).

Read [`okf-research.md`](okf-research.md) first: OKF is a *knowledge* format
(markdown concepts + YAML frontmatter), not a tabular data format. That
shapes everything below ([ADR-0001](decisions/0001-dataset-is-an-okf-bundle.md)).

## 1. System diagram

```
                 Browser (Next.js app, same origin via /api rewrite)
                   │                               │
                   │ cookie session + CSRF         │ presigned multipart PUTs
                   ▼                               ▼
             ┌────────────┐                 ┌──────────────┐
 API clients─►  API        │── presign ────►│ Object store │ (MinIO / S3 / GCS)
 (API keys)  │  Fastify    │                │  uploads/    │
             │  /api/v1    │◄── parquet ────│  blobs/      │
             └─┬───┬───┬──┘                 │  analytics/  │
               │   │   │  DuckDB (in-proc,  └──────▲───────┘
               │   │   │  per-version cache)       │
               │   │   ▼                           │
               │   │  Redis (rate-limit store)     │
               ▼   │                               │
          PostgreSQL ◄─── jobs (SKIP LOCKED) ──► Worker
          metadata, catalog,                     ingest pipeline:
          FTS, jobs, audit                       scan → detect → extract →
                                                 parse → validate → profile →
                                                 store → index
```

## 2. Components

| Component | Path | Responsibility |
|---|---|---|
| Web | `apps/web` | Next.js 16 App Router, React 19, Tailwind v4, shadcn-style components, TanStack Query, React Hook Form + Zod. Pure client of the REST API; no authorization logic. |
| API | `apps/api` | Fastify 5 + Zod type provider. Auth, RBAC, datasets, versions, uploads (presign), catalog search, query, sharing, API keys, audit log, OpenAPI generation, health/metrics. |
| Worker | `apps/worker` | Polls the Postgres `jobs` table; runs `ingest_version` and `diff_versions` pipelines with heartbeats, retries, cancellation. |
| `@okf/core` | `packages/okf` | Pure OKF engine: frontmatter/markdown parsing, link resolution, conformance validation, quality checks, schema extraction, profiling, version diffing. No I/O except reading a directory. |
| `@okf/archive` | `packages/archive` | Safe archive detection and extraction (zip/tar/tar.gz) with size, count, ratio and path limits; malware-scanner interface (ClamAV `clamd`). |
| `@okf/db` | `packages/db` | Drizzle schema, SQL migrations, typed client, Postgres job queue. |
| `@okf/storage` | `packages/storage` | Object storage interface + S3 implementation (multipart presign, streaming get/put, head, delete). |
| `@okf/query` | `packages/query` | `QueryEngine` interface + DuckDB implementation: parquet materialization, structured queries, sandboxed read-only SQL. |
| `@okf/config` | `packages/config` | Zod-validated environment configuration shared by API and worker. |
| `@okf/shared` | `packages/shared` | API contract types/schemas shared by API and web (roles, permissions, DTOs). |

Dependency direction: `apps/* → packages/*`; `packages/okf` and
`packages/shared` depend on nothing internal.

## 3. Domain model

```
Organization ─┬─ Members (owner | admin | editor | viewer)
              ├─ Invitations
              ├─ API keys (scoped, hashed)
              └─ Datasets ─┬─ Versions (v1, v2, … immutable content)
                           │     ├─ Files (content-addressed blobs)
                           │     ├─ Concepts (frontmatter as JSON, trust tier, staleness)
                           │     ├─ Links (resolved / broken)
                           │     ├─ Schema columns (from `# Schema` tables)
                           │     ├─ Validation run + issues
                           │     └─ Profile (stats JSON) + analytics parquet
                           ├─ Grants (per-user access for private datasets)
                           ├─ Share links (hashed tokens, read-only)
                           ├─ Tags (platform tags, distinct from OKF concept tags)
                           └─ Diffs (cached version comparisons)
```

### Dataset status

`DRAFT → PROCESSING → VALIDATED | FAILED`, `VALIDATED → PUBLISHED`,
`* → ARCHIVED`. Dataset status is derived from its versions and flags and
stored for filtering:

| Condition | Dataset status |
|---|---|
| `archived_at` set | `ARCHIVED` |
| a published version exists | `PUBLISHED` |
| latest version `PROCESSING` | `PROCESSING` |
| latest version `VALIDATED` | `VALIDATED` |
| latest version `FAILED` | `FAILED` |
| no versions | `DRAFT` |

### Version lifecycle and immutability

A version's content (archive, files, concepts, validation, profile) is written
once by the worker and never updated afterwards. Only `status`
(`PROCESSING → VALIDATED|FAILED → PUBLISHED`) and `published_at` change.
Published versions cannot be deleted; unpublishing clears the dataset's
`published_version_id` but the version row and data remain. A database
trigger rejects updates to content columns (see `database.md`).

## 4. Ingestion pipeline

1. **Upload** — client asks API for an upload session; API creates an S3
   multipart upload and returns presigned part URLs. Browser PUTs parts
   directly to object storage (progress, cancel, per-part retry). API never
   proxies file bytes. Alternatively **import** from an HTTPS URL (fetched by
   the worker behind an SSRF guard).
2. **Complete** — API verifies object size, then in **one transaction**
   creates the version (`PROCESSING`) and an `ingest_version` job.
3. **Worker** claims the job (`FOR UPDATE SKIP LOCKED`) and runs stages,
   reporting `stage` + `progress` on the job row:
   `fetch → scan → detect → extract → parse → validate → profile → store → index → finalize`.
4. Failure at any stage marks the version `FAILED` with a structured error;
   transient errors retry with backoff up to `max_attempts`.

See [ADR-0002](decisions/0002-postgres-job-queue.md) and
[ADR-0005](decisions/0005-direct-to-storage-uploads.md).

## 5. Storage layout

```
s3://$S3_BUCKET/
  uploads/{orgId}/{uploadId}/{filename}         raw uploaded archive (retained)
  blobs/{orgId}/{sha256[0:2]}/{sha256}           extracted files, content-addressed per tenant
  analytics/{orgId}/{versionId}/concepts.parquet DuckDB query artifacts
  analytics/{orgId}/{versionId}/links.parquet
  analytics/{orgId}/{versionId}/schema_columns.parquet
```

Blobs are deduplicated **within** an organization only, so object existence
never leaks across tenants. Metadata lives in PostgreSQL; no file bodies are
stored in PostgreSQL (only a bounded excerpt for full-text search).

## 6. Query

`QueryEngine` (`packages/query`) exposes `preview`, `structuredQuery` and
`sqlQuery`. The DuckDB implementation loads a version's parquet artifacts into
an **in-memory** database, then disables external access and locks
configuration before any user SQL runs. See
[ADR-0004](decisions/0004-duckdb-query-engine.md).

## 7. Search

`SearchProvider` interface; `PostgresSearchProvider` uses a weighted
`tsvector` on datasets (name A, tags/types B, description C, concept
titles/columns D) and on concepts, queried with `websearch_to_tsquery`.
Visibility filtering is applied inside the SQL, never after pagination.
OpenSearch can implement the same interface later.

## 8. Security model (summary)

Full detail in [`security.md`](security.md).

- Sessions: opaque random token in an `HttpOnly; SameSite=Lax` cookie;
  only its SHA-256 is stored. CSRF: double-submit token for cookie-auth
  mutations. API keys: `Authorization: Bearer okf_…`, SHA-256 hashed, scoped.
- All authorization is in `apps/api/src/auth/permissions.ts`
  (`can(principal, action, resource)`), unit-tested as a matrix.
- Tenant isolation: every query filters by `organization_id` derived from
  the resource, never from client input.

## 9. Observability

pino structured JSON logs with `requestId` (honours inbound `x-request-id`)
and `jobId`; Prometheus metrics at `/metrics`; `/health` (liveness) and
`/ready` (Postgres, Redis, object storage); `ErrorReporter` hook for an
external tracker.

## 10. Why not microservices

One API process and one worker type keep deployment simple, share code via
workspace packages, and are enough until measured load says otherwise. The
worker is stateless and scales horizontally because job claiming is
lock-based.

# ADR-0004: DuckDB over per-version parquet for querying

Status: Accepted — 2026-09-23

## Context

Users need filter/sort/paginate and "basic SQL" over dataset records
(concepts). Letting users run SQL against the shared PostgreSQL is a
multi-tenant risk. BigQuery would add a cloud dependency and cost for
bundles that are typically thousands of rows.

## Decision

- The worker materializes `concepts`, `links` and `schema_columns` parquet
  files per version into object storage.
- The API's `DuckDbQueryEngine` downloads them into a local cache, loads them
  into an **in-memory** DuckDB database per version (LRU-cached), then runs
  `SET enable_external_access = false; SET lock_configuration = true;` before
  executing any user SQL. User SQL must parse as exactly one `SELECT`
  statement, is wrapped with a row `LIMIT`, and is interrupted on timeout.
- Structured queries (column selection, filters, sort, pagination) are
  compiled to parameterized SQL from a whitelist of columns/operators.

## Consequences

- User SQL cannot read files, network, or other tenants' data.
- The `QueryEngine` interface allows swapping to BigQuery/Postgres later.
- Memory bounded via `memory_limit` and the LRU size.

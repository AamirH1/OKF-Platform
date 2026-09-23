# ADR-0002: PostgreSQL-backed job queue instead of BullMQ

Status: Accepted — 2026-09-23

## Context

Long-running work (ingestion, validation, profiling, indexing, diffing) must
run outside HTTP requests. The brief requires a `jobs` table with
`QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED` visible to the frontend.
BullMQ would keep job state in Redis *and* require mirroring it into
Postgres (dual write, inconsistency on crash). BullMQ 6 was released recently
with API changes we have not validated.

## Decision

Implement the queue in PostgreSQL:

- `jobs` rows are inserted in the **same transaction** as the domain change
  that needs them (e.g. version creation).
- Workers claim with `UPDATE … WHERE id = (SELECT id … FOR UPDATE SKIP LOCKED
  LIMIT 1)`, heartbeat every few seconds, and a reaper re-queues jobs whose
  heartbeat is stale (worker crash) until `max_attempts`.
- Retries use exponential backoff via `run_after`.
- Cancellation: `cancel_requested` flag checked between pipeline stages.

Redis remains for distributed rate limiting.

## Consequences

- Exactly one source of truth for job status; transactional enqueue.
- Throughput is bounded by Postgres, adequate for ingestion jobs (seconds to
  minutes each, low QPS). Revisit if job volume exceeds ~100 jobs/s.

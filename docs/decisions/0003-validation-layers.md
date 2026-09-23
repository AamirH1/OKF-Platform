# ADR-0003: Separate structural conformance from quality checks

Status: Accepted — 2026-09-23

## Context

OKF v0.2 §11 defines conformance narrowly and lists things consumers
MUST NOT reject a bundle for (missing optional fields, unknown types/keys,
broken links, missing `index.md`). The brief asks for both OKF validation and
data-quality checks, kept separate.

## Decision

`@okf/core` returns a `ValidationResult` whose issues carry
`layer: "structural" | "quality"`:

- `structural` issues (always `severity: "error"`) come only from §11 rules
  1–3. `valid === (no structural issues)`.
- `quality` issues (`warning` / `info`) are platform heuristics and never
  affect `valid`.

Every issue has a stable `code` (e.g. `OKF_MISSING_TYPE`, `Q_BROKEN_LINK`),
`message`, `severity`, `location` (`{ path, line?, column? }`) and optional
`field`.

## Consequences

A bundle that is spec-conformant is always accepted and publishable, even
with many quality warnings. Invalid (non-conformant) versions are `FAILED` and
cannot be published.

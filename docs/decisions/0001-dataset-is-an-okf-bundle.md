# ADR-0001: A platform dataset is a versioned OKF knowledge bundle

Status: Accepted — 2026-09-23

## Context

The product brief assumed OKF is a tabular data format (columns, data types,
partitioning, null percentages, row counts). Research of the OKF v0.2
specification (`docs/okf-research.md`) shows OKF is a *knowledge* format: a
directory of markdown concept documents with YAML frontmatter, where `type`
is the only required key. It defines no rows, data types, or partitions, and
lists "prescribing storage, serving, or query infrastructure" as a non-goal.

Rule 10 of the brief: "Do not invent OKF behavior."

## Decision

- A **dataset** is a named, access-controlled container of **versions**; each
  version is one uploaded OKF bundle (zip / tar / tar.gz / single `.md`).
- The **records** the platform previews, profiles, queries and diffs are the
  bundle's **concepts**: one row per concept with first-class columns for the
  spec-defined keys (`type`, `title`, `description`, `resource`, `tags`,
  `status`, `stale_after`, `generated`, `verified`) plus derived columns
  (`trust_tier`, `is_stale`, link counts) and a JSON column with the full
  frontmatter.
- "**Schema**" is shown in two explicitly labelled forms: the inferred
  *frontmatter field schema* (platform-derived) and *asset schemas* parsed from
  `# Schema` body tables (producer documentation).
- Profiling statistics (presence %, distinct counts, min/max) are computed over
  concepts and frontmatter fields — never presented as statistics about the
  underlying data the concepts describe.

## Consequences

- Every feature in the brief has a truthful OKF interpretation; nothing is
  labelled as OKF that the spec does not define.
- Previewing *actual* table data described by a concept (e.g. a BigQuery
  table) is out of scope; it would require credentials to third-party systems.
  Recorded as a future improvement.

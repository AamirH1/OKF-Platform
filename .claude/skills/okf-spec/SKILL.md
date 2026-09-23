---
name: okf-spec
description: Condensed OKF v0.2 spec rules (conformance, frontmatter keys, trust tiers, links, index/log, Attested Computation). Use instead of fetching or reading SPEC.md / docs/okf-research.md when you need an OKF rule while editing packages/okf or validation code.
---

# OKF v0.2 cheatsheet (canonical: github.com/GoogleCloudPlatform/open-knowledge-format SPEC.md)

Only read `docs/okf-research.md` if a rule below is insufficient. Never invent OKF fields.

## Bundle
- Directory of UTF-8 `.md` files. Concept ID = path minus `.md`. Distributed as git repo, tarball, zip, or subdir.
- Reserved at any level: `index.md`, `log.md` (never concepts). All other `.md` = concepts. Non-md files allowed, not concepts.

## Concept frontmatter (`---` delimited YAML mapping at file start)
- REQUIRED: `type` (non-empty string, free vocabulary, unknown types MUST be tolerated).
- Recommended: `title`, `description` (one sentence), `resource` (URI), `tags` (list).
- Extensions: any key; consumers SHOULD preserve, MUST NOT reject.
- Timestamps: ISO 8601 with explicit UTC offset.
- `sources: [{resource (REQUIRED), id, title, author, usage_count, last_modified}]`, sibling `usage_window: {from,to}` (entry may override).
- `generated: {by (REQUIRED), at}`; v0.1 fallback: `timestamp`.
- `verified`: list of `{by, at}`; bare mapping MUST be treated as 1-element list.
- Trust tier: none → `unverified`; only non-`human:` actors → `machine-confirmed`; any `human:` → `human-reviewed`. Advisory, not access control.
- `status`: draft | stable | deprecated; absent ⇒ stable.
- `stale_after`: absolute instant; stale iff now >= it. Ignore date-only / no-offset values (reference impl behavior).
- Actors: `<producer>/<version>`, `human:<id>`, `process:<id>` (samples also use `team:<id>` for source authors).

## Body
- Free markdown. Conventional headings: `# Schema` (usually table `Column | Type | Description`), `# Examples`, `# Computation`.
- Footnote label = `sources[].id` for per-claim attribution. v0.1 legacy: `# Citations` list.

## Links
- Markdown links; `/abs` = bundle-root relative (recommended), else relative. Untyped directed edges.
- Broken links MUST be tolerated (never an error).
- Path-valued fields: `resource`, `sources[].resource` (may be a non-path scope descriptor), `computation`, `executor.resource`, `attester.resource`.

## index.md / log.md
- index.md: no frontmatter, EXCEPT bundle-root index.md may have `okf_version`. Body: `# Heading` + `* [Title](url) - desc` bullets (SHOULD).
- log.md: date-grouped, newest first; date headings MUST be `YYYY-MM-DD`. Frontmatter not forbidden (acme sample has `type: Log`).

## Attested Computation (`type: Attested Computation`)
- `runtime` REQUIRED for this type; `parameters: [{name,type,required}]`; `computation` (path) or body `# Computation` fence; `executor: {resource, receipt: [...]}`; `attester: {resource}`. OKF never executes anything.

## Conformance (§11) — the ONLY structural errors
1. Every non-reserved `.md` has parseable YAML frontmatter block.
2. Every such block has non-empty `type`.
3. Reserved files follow §8/§9 when present.
MUST NOT reject for: missing optional fields, unknown types, unknown keys, broken links, missing index.md. Unknown `okf_version` ⇒ best effort.

## Project mapping (ADR-0001/0003)
- Dataset = versioned bundle; record = concept; structural issues → `valid=false`; quality issues never affect validity.

# Open Knowledge Format (OKF) — Research Notes

Research date: 2026-09-23. Spec version studied: **OKF v0.2**.

This document separates three things that are easy to conflate:

| Label | Meaning |
|---|---|
| **[SPEC]** | Normative or informative content of the OKF specification (`SPEC.md`). |
| **[GOOGLE]** | Google's implementations: reference agent, viewer, Knowledge Catalog connector, BigQuery-specific conventions. |
| **[APP]** | This application's own architecture and interpretation. Not part of OKF. |

---

## 1. Sources

| Source | URL | Notes |
|---|---|---|
| Announcement blog post | https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing | Announces OKF **v0.1** (2026-06-12). |
| Canonical spec repository | https://github.com/GoogleCloudPlatform/open-knowledge-format | Canonical home of `SPEC.md` (v0.2), reference agent, sample bundles. Commit studied: `ad30107` (2026-08-21). |
| Spec text | https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md | Self-contained, v0.2. |
| Former location (frozen) | https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf | README says: "Stop using the copy under `okf/` … It is a frozen snapshot". `SPEC.md` was byte-identical to the canonical repo on the research date. |
| Knowledge Catalog connector | https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/connectors/gcp-knowledge-catalog.md | How to push/pull a bundle to Google Cloud Knowledge Catalog via `kcmd`. |
| `kcmd` / mdcode toolbox | https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/toolbox/mdcode | Google tooling (TypeScript/Bun). |
| Knowledge Catalog docs | https://docs.cloud.google.com/dataplex/docs/catalog-overview | Knowledge Catalog = renamed Dataplex Universal Catalog (2026-04-10). |
| Knowledge Catalog custom sources | https://docs.cloud.google.com/knowledge-catalog/docs/ingest-custom-sources | Generic custom-entry ingestion (not OKF-specific). |

The blog post announced v0.1; the repository now specifies **v0.2**, which
supersedes v0.1 with two deliberate breaking changes (§13 of the spec, see
below). This application targets v0.2 and reads v0.1 bundles through the
fallbacks the spec defines.

---

## 2. What OKF is — and is not

**[SPEC]** OKF is "an open, human- and agent-friendly format for representing
*knowledge*: the metadata, context, and curated insight that surrounds data
and systems." A bundle is "a directory of markdown files with YAML
frontmatter. There is no schema registry, no central authority, and no
required tooling."

Explicit **non-goals** (§1):

- Defining a fixed taxonomy of concept types.
- Prescribing storage, serving, or query infrastructure.
- Replacing domain-specific schemas (Avro, Protobuf, OpenAPI …). "OKF
  *references* them; it does not subsume them."
- Specifying packaging/invocation for executor or attester code.

### Consequences for this project **[APP]**

OKF is **not a tabular data format**. It has no notion of rows, column data
types, partitions, or data files. The original product brief assumed a
tabular format ("partitioning", "data types", "null percentage", "row
count"). We do not invent those for OKF. Instead (see
[ADR-0001](decisions/0001-dataset-is-an-okf-bundle.md)):

- A platform **dataset** is a **versioned OKF knowledge bundle**.
- The **records** we preview, profile and query are the bundle's
  **concepts** (one concept = one row; frontmatter keys = fields).
- "**Schema**" has two meanings, both kept explicit:
  1. the *frontmatter field schema* the platform infers across concepts
     (field name, observed JSON types, presence %), and
  2. *asset schemas* described inside concepts under the conventional
     `# Schema` body heading (§4.2) — the columns of the tables that the
     concepts describe. These are parsed from markdown tables and are
     documentation, not enforced schemas.
- "Partitioning" has no OKF meaning; the nearest OKF concept is the
  directory hierarchy, which is producer-defined and domain-independent (§3).

---

## 3. Terminology **[SPEC §2]**

- **Knowledge Bundle** — self-contained hierarchical collection of
  knowledge documents; the unit of distribution.
- **Concept** — one markdown document; describes a tangible asset (table,
  API) or an abstract idea (metric, process).
- **Concept ID** — the file path within the bundle, `.md` suffix removed.
- **Frontmatter** — YAML block delimited by `---` at the top of the file.
- **Body** — everything after the frontmatter.
- **Link** — standard markdown link between concepts.
- **Source / Provenance** — materials a concept derives from (`sources`).
- **Credibility signal** — objective per-source fact (`author`,
  `usage_count`, `last_modified`); OKF records signals, not verdicts.
- **Actor** — `<producer>/<version>`, `human:<id>`, or `process:<id>`.
- **Trust tier** — derived from `verified`: unverified, machine-confirmed,
  human-reviewed.
- **Attested Computation**, **Executor**, **Receipt**, **Attester** — see §10.

---

## 4. File structure **[SPEC §3]**

```
path/to/bundle/
  index.md          # Optional. Directory listing (progressive disclosure).
  log.md            # Optional. Chronological history of updates.
  <concept>.md      # A concept at the bundle root.
  <subdirectory>/
    index.md
    <concept>.md
```

- Directory structure is producer-defined and domain-independent.
- Distribution: a git repository (recommended), a **tarball or zip archive**,
  or a subdirectory of a larger repository.
- **Reserved filenames** at any level, which MUST NOT be used for concepts:
  `index.md` (§8) and `log.md` (§9). All other `.md` files are concepts.
- Non-markdown files may exist (e.g. `references/attesters/revenue.py` in the
  spec's examples; the sample `acme_retail` bundle ships `attesters/sql_equality.py`
  and generated `viz.html`). The spec does not define them as concepts.
- Tags are first-class via frontmatter; OKF defines **no** tag-aggregation
  file format. Consumers may synthesize tag views.

## 5. Concept documents and metadata structure **[SPEC §4]**

UTF-8 markdown: a YAML frontmatter block delimited by `---` lines, then a
free-form markdown body.

| Key | Status | Notes |
|---|---|---|
| `type` | **REQUIRED**, non-empty | Free string. Not centrally registered. Examples: `BigQuery Table`, `BigQuery Dataset`, `API Endpoint`, `Metric`, `Playbook`, `Reference`, `Attested Computation`. Consumers MUST tolerate unknown types. |
| `title` | Recommended | If absent, consumers MAY derive from filename. |
| `description` | Recommended | One sentence; used by index generators, snippets. |
| `resource` | Recommended | URI identifying the underlying asset. Absent for abstract concepts. |
| `tags` | Recommended | YAML list of short strings. |
| provenance / trust / lifecycle families | Optional | §5 below. |
| computation fields | Optional | For `type: Attested Computation`, §10. |
| any other key | Extension | Producers MAY add; consumers SHOULD preserve on round-trip and MUST NOT reject. |

A concept carrying only `type` is fully conformant.

### Body **[SPEC §4.2]**

No required sections. Conventional headings:

| Heading | Purpose |
|---|---|
| `# Schema` | Structured description of an asset's columns/fields. |
| `# Examples` | Usage examples, often fenced code. |
| `# Computation` | The sanctioned computation of an Attested Computation. |

Per-claim attribution uses markdown footnotes whose label equals a
`sources[].id` (e.g. `[^ga4-schema]`).

### Schema conventions

**[SPEC]** Only the `# Schema` heading is specified; its internal format is
not. The spec example (§4.3) and all Google sample bundles use a markdown
table with `Column | Type | Description` headers, types in the source
system's vocabulary (e.g. `STRING`, `NUMERIC(18,4)`, `TIMESTAMP`).

**[APP]** We parse the first GFM table under a `# Schema` heading, look for
column-name and type columns by header name (case-insensitive: `column`,
`field`, `name` / `type`, `data type`), strip inline code backticks, and
record the result as an *asset schema*. If no table can be parsed we record
nothing and emit an informational quality note — never a conformance error.

## 6. Provenance, trust, lifecycle **[SPEC §5]**

All optional; absence carries meaning but never causes rejection.
Every timestamp-valued key is ISO 8601 **with an explicit UTC offset**.

- `sources`: list of entries; each entry REQUIRES `resource` (absolute URL,
  bundle-relative path, `references/` path, or a non-path *scope
  descriptor* like "all queries in project X"). Optional `id`, `title`,
  `author` (actor), `usage_count`, `last_modified`.
- `usage_window: { from, to }` sibling of `sources`; entries may override.
- `generated: { by, at }` — `by` REQUIRED within `generated` (an actor);
  `at` marks last meaningful content change.
- `verified` — list of `{ by, at }`; a bare mapping MUST be treated as a
  one-element list.
- Trust tier (§5.3): no `verified` ⇒ unverified; only non-`human:` actors ⇒
  machine-confirmed; any `human:` actor ⇒ human-reviewed. Advisory only,
  "not access control".
- `status`: `draft | stable | deprecated`; absent ⇒ `stable`.
- `stale_after`: absolute instant; stale when `now >= stale_after`.

**[GOOGLE]** The reference parser ignores `stale_after` values without a
`T` or without a timezone (date-only is ambiguous). We adopt the same
behavior **[APP]** and surface a quality warning.

## 7. Cross-linking and paths **[SPEC §6]**

- Links are standard markdown links. Two forms:
  - bundle-relative, starting with `/` (recommended);
  - relative (`./other.md`, `../x/y.md`).
- A link asserts an *untyped* directed relationship; kind is in the prose.
- Consumers **MUST tolerate broken links** (may be not-yet-written knowledge).
- Path-valued fields: `resource`, `sources[].resource`, `computation`,
  `executor.resource`, `attester.resource` — absolute URL, `/`-path, or
  relative path.
- `references/` subdirectory is a naming convention, not a requirement.

Note: the Google `acme_retail` sample uses paths such as
`policies/revenue-recognition.md` in `sources[].resource` from a concept at
`tables/orders.md`. Under strict relative resolution that would point to
`tables/policies/...`. **[APP]** When resolving path-valued *frontmatter*
fields we try relative-to-concept first and fall back to bundle-root;
body links are resolved strictly relative (per standard markdown). Both are
reported as warnings, never errors.

## 8. Actor convention **[SPEC §7]**

`<producer>/<version>` (agents/tools), `human:<id>` (people),
`process:<id>` (automated). Producers MUST use `human:` for human content.
Samples also use `team:<id>` for source `author` — not in the spec's list;
**[APP]** we accept it with an informational note.

## 9. Index and log files **[SPEC §8, §9]**

- `index.md`: no frontmatter, except the bundle-root `index.md` MAY carry
  `okf_version`. Body: sections under headings with bullet entries
  `* [Title](relative-url) - description`. Consumers MAY synthesize one.
- `log.md`: flat list of date-grouped entries, newest first. Date headings
  MUST be `YYYY-MM-DD`. Bold leading word is conventional. §9 is silent on
  frontmatter in `log.md`; **[GOOGLE]** `acme_retail/log.md` carries
  `type: Log` frontmatter.

## 10. Attested Computation **[SPEC §10]**

A concept with `type: Attested Computation`:

- `runtime`: REQUIRED for this type (e.g. `bigquery`, `postgres`, `dbt`).
- `parameters`: list of `{ name, type, required }`.
- `computation`: optional path; absent ⇒ the body `# Computation` fence.
- `executor: { resource, receipt: [...] }`, `attester: { resource }`.
- OKF "records the computation and the means to check it; it does not
  execute anything itself". Receipts are runtime artifacts, not stored.

**[APP]** We validate the contract's *shape* and display it. We do **not**
execute computations or attesters: running arbitrary uploaded code or SQL
against third-party runtimes is outside scope and a security risk.

## 11. Conformance and validation **[SPEC §11]**

A bundle is conformant with v0.2 if:

1. Every non-reserved `.md` file has a parseable YAML frontmatter block.
2. Every frontmatter block has a non-empty `type`.
3. Reserved files (`index.md`, `log.md`) follow §8/§9 when present.

Consumers MUST NOT reject a bundle because of: missing optional fields,
unknown `type` values, unknown keys, broken cross-links, missing `index.md`.
Consumers MUST treat a bare `verified` mapping as a one-element list and MUST
NOT reject for missing optional families.

**[APP]** Our validator has two strictly separated layers
(see [ADR-0003](decisions/0003-validation-layers.md)):

- **Structural conformance** — only the §11 rules above produce `error`
  severity; `valid` is `true` iff there are zero structural errors.
- **Quality checks** — application-level findings (missing
  title/description, broken links, stale concepts, non-UTC timestamps,
  malformed `sources` entries, Attested Computation without `runtime`,
  non-ISO log headings…) as `warning` / `info`. They never make a bundle
  invalid, honoring the MUST NOT rules.

Rule 3 is interpreted conservatively: an `index.md` with frontmatter that is
*not* the bundle root, or a root `index.md` whose frontmatter contains keys
other than `okf_version`, is a structural error; a `log.md` date heading not
in `YYYY-MM-DD` form is a structural error (the spec says MUST). Index body
formatting deviations are warnings, since §8 uses SHOULD.

Precisely: in `log.md`, every level-2 (`##`) heading is treated as a date
heading and must match `YYYY-MM-DD`. §9 does not forbid frontmatter in
`log.md` (the Google `acme_retail` sample has `type: Log` frontmatter), so a
log's frontmatter, if present, is parsed but not required to contain `type`.
A malformed YAML block in a reserved file is still a structural error.

## 12. Data types

**[SPEC]** None defined for data. Frontmatter is YAML; `parameters[].type`
for computations is free text interpreted by `runtime`.

**[GOOGLE]** The reference parser uses a YAML *SafeLoader with timestamp
resolution disabled*, so ISO datetimes remain strings and round-trip
byte-for-byte (YAML 1.2 core schema behavior).

**[APP]** We parse with the `yaml` npm package in YAML 1.2 core schema mode,
which likewise keeps timestamps as strings, and we disable custom tags and
cap alias expansion to prevent billion-laughs attacks.

## 13. Partitioning

**[SPEC]** Not applicable. The only structure is the directory tree, which is
producer-defined. **[GOOGLE]** Sample bundles group by asset kind
(`datasets/`, `tables/`, `metrics/`, `references/`). BigQuery-specific
constructs such as sharded `events_YYYYMMDD` tables appear only as prose.

## 14. Versioning **[SPEC §12, §13]**

- `<major>.<minor>`; minor = backward-compatible additions, major may break.
- Bundle MAY declare `okf_version: "0.2"` in root `index.md` frontmatter.
- Unknown versions: consumers SHOULD attempt best-effort consumption.
- v0.1 → v0.2 breaking changes: `timestamp` superseded by `generated.at`
  (consumers MAY fall back); body `# Citations` superseded by `sources`
  (consumers MAY parse legacy list).
- Deferred to future revisions: receipt/verdict wire formats, attester ABI
  and sandboxing, attestation caching, semantic-layer templates.

## 15. Interoperability & tooling

| Tool | Owner | Role |
|---|---|---|
| Reference agent (`reference_agent enrich`) | [GOOGLE] | Python; walks a BigQuery dataset, drafts concepts, LLM web pass enriches with citations. Needs Gemini + BigQuery credentials. |
| Viewer (`reference_agent visualize`) | [GOOGLE] | Self-contained HTML force-directed graph of a bundle (`viz.html`). |
| `kcmd` connector | [GOOGLE] | Push/pull a bundle to a Knowledge Catalog EntryGroup. Carries **seven** keys: `title`, `description`, `tags` → native fields; `resource` → `catalogEntry.resource.name`; `type`, `generated`, `sources` → a custom `okf` aspect. Other keys are lost; first pull normalizes YAML formatting; synthesizes `index` entries. |
| Obsidian, MkDocs, Hugo, Jekyll, Notion, GitHub | third party | Already render markdown + frontmatter. |

**[APP]** Interop commitments of this platform:

- We store the uploaded bundle **byte-for-byte** and serve downloads of the
  original archive, so round-tripping never loses unknown keys (§4.1
  SHOULD).
- Our export produces a plain `.tar.gz` of the stored files — itself a valid
  OKF distribution form (§3).

## 16. Sample bundles

**[GOOGLE]** In the canonical repo under `bundles/`: `ga4`, `stackoverflow`,
`crypto_bitcoin` (agent-generated from BigQuery public datasets) and
`acme_retail` (a hand-curated example exercising every v0.2 family,
including Attested Computations). 78 markdown files total.

**[APP]** `tests/fixtures/okf/acme_retail/` vendors the `acme_retail` bundle
under Apache-2.0 with attribution (see `tests/fixtures/okf/NOTICE`), plus our
own valid/invalid/edge-case fixtures.

## 17. Licensing

The spec repository is licensed under **Apache License 2.0**
(`LICENSE.md`, "Copyright 2026 Google LLC" headers). The blog states it is an
open specification and that alternative implementations "are all explicitly
welcomed" and it "will never require a proprietary account or SDK to read,
write, or serve." Individual bundles carry whatever license their producer
chooses — OKF defines no license field. **[APP]** We let dataset owners set a
free-text `license` on the dataset record (platform metadata, not OKF).

## 18. Limitations of OKF v0.2 (as relevant to this platform)

- Only `type` is required, so metadata quality varies widely.
- No typed relationships: links are untyped edges.
- No machine-readable schema format; `# Schema` is prose/tables.
- No data, no statistics, no row counts — any "profiling" is about
  knowledge metadata, not data.
- No identity beyond file paths; renames change concept IDs.
- Attestation wire formats deferred.
- Relative-path semantics of frontmatter path fields are under-specified
  (see §7 above).

## 19. Compatibility considerations for this platform **[APP]**

- Accept `.zip`, `.tar.gz`/`.tgz`, `.tar`, and single `.md` files.
- Detect the bundle root: if the archive has exactly one top-level directory
  and no top-level `.md` files, that directory is the root (tarballs commonly
  wrap content in a folder).
- Accept v0.1 bundles: fall back to `timestamp` when `generated` is absent;
  parse legacy `# Citations` lists for display only.
- Unknown `okf_version`: best-effort parse + info note.
- Preserve every frontmatter key in stored metadata (`frontmatter` JSON).
- Non-markdown files are stored and listed but not interpreted.

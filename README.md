<div align="center">

# OKF Platform

**A catalog for your team's knowledge about data — built on the open [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format).**

![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6)
![Next.js](https://img.shields.io/badge/Next.js-16-000000)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169e1)
![OKF](https://img.shields.io/badge/OKF-v0.2-6b7280)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

</div>

---

## Why OKF?

Every organization has data, but the **knowledge about that data** is scattered: what a table
actually contains, which column to join on, how "revenue" is officially calculated, who checked
it, and whether it is still true. That knowledge usually lives in people's heads, old wiki
pages, Slack threads, or locked inside one vendor's catalog tool. New teammates can't find it,
and increasingly **AI assistants can't either** — so they guess, and guess wrong.

The **Open Knowledge Format (OKF)** is an open standard, published by Google in 2026, that fixes this
by writing that knowledge down in the simplest possible form:

- **Just text files.** Each thing you want to describe — a table, a metric, a policy, a how-to —
  is one Markdown file (a *concept*) with a short header. A folder of them is a *bundle*.
- **Readable by people and machines.** Anyone can open it in a text editor or on GitHub, and an
  AI agent can load it directly as trusted context.
- **Trust is built in.** Each concept can record where it came from, who verified it, and when it
  expires — so you know how much to rely on it.
- **No lock-in.** It's an open, vendor-neutral format. No account, SDK or proprietary tool is
  needed to read or write it, and it versions naturally in git.

```markdown
---
type: BigQuery Table
title: Orders
description: One row per completed customer order.
verified: { by: human:ana, at: 2026-07-01T00:00:00Z }
---
# Schema
| Column   | Type    | Description         |
| order_id | STRING  | Unique order id.    |
```

## What this platform does

OKF defines the format; **OKF Platform** is the place to manage it. Upload a bundle and it is
automatically checked, organized and made easy to explore and share:

1. **Upload** a `.zip` / `.tar.gz` of your bundle — it goes straight to secure storage.
2. **Check** — it is scanned, safely unpacked and validated against the OKF rules, with clear
   errors (must fix) separated from suggestions (nice to fix).
3. **Explore** — browse concepts like a spreadsheet, see documented table schemas, follow links
   on an interactive graph, search everything, or ask questions with SQL.
4. **Version** — every upload is a frozen version; compare any two to see exactly what changed.
5. **Publish & share** — make one version official and share it with your team, specific people,
   a private link, the public, or other tools via the API.

Built for data teams, analysts and anyone preparing reliable knowledge for AI assistants.

## Features

- **Guided UI** — a Home page that explains everything in plain language, a “What is this?” tip on
  every screen, and hover definitions for every term.
- **Fast navigation** — ⌘K command palette, breadcrumbs, and light / dark / system themes.
- **Safe ingestion** — direct multipart uploads with progress, cancel and resume; malware
  scanning; protection against malicious archives and unsafe URLs.
- **Clear validation** — every finding has a code, file and line number.
- **Exploration** — concept table with statistics, schema viewer, zoomable concept graph,
  full-text search, visual query builder and read-only SQL (DuckDB).
- **Versioning** — immutable versions with checksums and side-by-side comparison.
- **Teams** — organizations, invitations, Owner / Admin / Editor / Viewer roles, private /
  organization / public visibility, share links.
- **API** — versioned REST API with OpenAPI spec, scoped API keys, rate limits and a full audit log.

## Quick start

Requires **Node.js ≥ 22.12** and **Docker**.

```bash
git clone https://github.com/AamirH1/OKF-Platform.git && cd OKF-Platform
npm install
docker compose up -d     # database, storage, cache, test mail server
npm run dev              # open http://localhost:3000
npm run db:seed          # optional demo data — login: demo@okf.local / demo password for okf
```

Other local services: API `http://localhost:4000` · storage console `http://localhost:9001` ·
test inbox for password-reset emails `http://localhost:8025`.

## Tech stack

Next.js 16 · React 19 · Tailwind CSS 4 · Fastify 5 · PostgreSQL 17 · S3-compatible storage (MinIO / S3 / GCS) ·
Redis · DuckDB · TypeScript throughout. A single API service plus a background worker — no microservices.

## Development & testing

| Command | What it does |
|---|---|
| `npm run dev` | Run web, API and worker together |
| `npm run check` | Typecheck, lint and unit tests |
| `npm run test:integration` | API + worker tests against real services |
| `npm run test:e2e` | Browser tests of the full user journey (Playwright) |
| `npm run openapi` | Regenerate the API spec |

All configuration options are documented in [`.env.example`](.env.example).

## Documentation

| | |
|---|---|
| [Why and what: OKF research](docs/okf-research.md) | The OKF spec explained, and how this platform interprets it |
| [Architecture](docs/architecture.md) | How the pieces fit together, plus [decision records](docs/decisions/) |
| [API](docs/api.md) | Endpoints, authentication, examples ([OpenAPI](docs/openapi.yaml)) |
| [Security](docs/security.md) | Threat model and controls |
| [Deployment](docs/deployment.md) | Docker, production and Google Cloud setup |
| [Database](docs/database.md) | Schema and migrations |

## License

[Apache License 2.0](LICENSE). The OKF sample bundles in `tests/fixtures/okf` are © Google LLC,
Apache-2.0 ([NOTICE](tests/fixtures/okf/NOTICE)).

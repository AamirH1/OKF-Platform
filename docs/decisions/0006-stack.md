# ADR-0006: Technology stack

Status: Accepted — 2026-09-23

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript 6.0 (strict) | Shared types across web/API/worker. TS 7 (native) not yet supported by typescript-eslint (`<6.1`). |
| Monorepo | npm workspaces | Required `npm install` workflow; no extra tool needed. |
| API | Fastify 5 + fastify-type-provider-zod | Fast, plugin ecosystem (helmet, cors, cookie, rate-limit, swagger); Zod schemas drive validation *and* OpenAPI. NestJS adds DI ceremony without a clear benefit here. |
| DB | PostgreSQL 17 + Drizzle ORM | Typed SQL, generated SQL migrations committed to the repo. |
| Queue | PostgreSQL (ADR-0002) | Transactional enqueue. |
| Rate limiting | Redis via @fastify/rate-limit | Shared counters across API instances. |
| Object storage | S3 API (@aws-sdk/client-s3); MinIO locally | Portable across AWS/GCS/MinIO. |
| Query | DuckDB (`@duckdb/node-api`) (ADR-0004) | Embedded, fast, sandboxable. |
| YAML | `yaml` (YAML 1.2 core) | Timestamps stay strings (matches Google reference parser); alias limits. |
| Markdown | unified + remark-parse + remark-gfm | Real AST for links, headings, GFM tables. |
| Passwords | Argon2id (@node-rs/argon2) | OWASP-recommended. |
| Frontend | Next.js 16, React 19, Tailwind v4, Radix/shadcn-style UI, TanStack Query, RHF, Zod | As recommended by the brief; no research reason to deviate. |
| Tests | Vitest, Playwright | Fast unit/integration; browser E2E. |
| Email | nodemailer SMTP; Mailpit locally | Password reset and invitations. |

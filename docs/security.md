# Security

This document describes the security model of OKF Platform: each control, where it
lives in code, and how it is tested. Report vulnerabilities privately to the
maintainers; do not open public issues for them.

## Threat model (summary)

| Asset | Threats | Primary controls |
|---|---|---|
| Accounts & sessions | credential stuffing, session theft, CSRF | Argon2id, rate limits, HttpOnly/SameSite cookies, CSRF tokens + Origin check |
| Tenant data (datasets, versions, concepts) | cross-tenant reads/writes, privilege escalation | server-side RBAC on every route, tenant-scoped queries, API key scoping |
| Worker hosts | malicious archives (zip slip, bombs, links), malware, SSRF via imports | sandboxed extraction with limits, ClamAV (fail-closed), connect-time IP checks |
| Query engine | SQL injection, file/network access via SQL | whitelisted structured queries, in-memory DuckDB with external access disabled |
| Browsers of viewers | stored XSS from uploaded markdown | react-markdown without raw HTML, URL scheme allow-list, strict CSP |
| Audit integrity | repudiation | append-only audit log written in the same transaction as changes |

## Authentication

- **Passwords**: Argon2id (m = 19 MiB, t = 2, p = 1, OWASP) via `@node-rs/argon2`
  (`apps/api/src/lib/crypto.ts`). Minimum length 12, maximum 256 (NIST 800-63B:
  length over composition rules).
- **Account enumeration**: login returns the same message for unknown users and wrong
  passwords, and verifies a dummy hash for unknown users so timing is similar.
  Forgot-password always returns 202. Signup does reveal an existing email (409) — an
  accepted usability trade-off, rate-limited.
- **Sessions**: 256-bit random token in `okf_session` (`HttpOnly`, `SameSite=Lax`,
  `Secure` in production). Only the SHA-256 hash is stored (`sessions.token_hash`).
  Sessions expire (`SESSION_TTL_HOURS`), can be listed and revoked individually, and all
  are revoked on password reset; other sessions are revoked on password change.
- **Password reset**: single-use, 1-hour token, stored hashed, consumed atomically.
- **OAuth/OIDC-ready**: `auth_identities (provider, provider_subject)` exists and
  `users.password_hash` is nullable, so providers can be added without schema changes.

## CSRF and cross-origin requests

Cookie-authenticated mutations (`POST/PUT/PATCH/DELETE`) require `x-csrf-token` equal to
the per-session CSRF token (synchronizer token; the server stores only its hash). The
token is delivered in a readable `okf_csrf` cookie (`SameSite=Strict`). Independently,
any unsafe request carrying an `Origin` header other than `WEB_ORIGIN` is rejected
(`ORIGIN_REJECTED`) — this also prevents login CSRF. API-key requests are exempt from
CSRF (no ambient credentials). CORS allows only `WEB_ORIGIN`. The web app reaches the
API through a same-origin rewrite, so no cross-origin requests are needed in normal use.

Tests: `apps/api/test/integration/security.test.ts` (“authentication and sessions”).

## Authorization (RBAC) and tenant isolation

All decisions go through `canOrg` / `canDataset` in `packages/shared/src/permissions.ts`.
The API resolves every fact (membership role, grants, visibility, published state) from
the database per request (`apps/api/src/services/access.ts`); the web app imports the same
module only to hide controls. Client-supplied permissions are never trusted.

| Role | Can |
|---|---|
| viewer | read organization datasets (non-private), query, download |
| editor | + create datasets, upload versions, edit metadata |
| admin | + publish/unpublish, share, archive, delete datasets; manage members (not owners/admins), invitations, see all API keys, read audit log |
| owner | + delete the organization, manage owners/admins |

Dataset visibility: `private` (creator, owners/admins, explicit grants), `organization`
(all members), `public` (anyone, **published version only**). Share links give read-only
access to the published version only. Invisible resources return **404, not 403**, so
organizations and datasets cannot be enumerated. The last owner cannot leave or be demoted.

Tenant isolation: every dataset/version/concept row carries `organization_id`; lookups go
through the dataset's own organization; object keys are prefixed by organization
(`blobs/{orgId}/…`); content-addressed blobs are deduplicated **within** an organization
only, so object existence never leaks across tenants. API keys only act within their own
organization. Catalog search applies visibility inside SQL before pagination; dataset
search text comes from the published version so draft content never appears in public
search snippets.

Tests: `packages/shared/test/permissions.test.ts` (full access matrix) and the RBAC,
private-dataset and API-key sections of the security integration test.

## API keys

Format `okf_<8-char id>_<43-char secret>`. Only the SHA-256 hash is stored; the id is a
public lookup prefix. Keys have scopes (`datasets:read`, `datasets:write`,
`datasets:publish`), optional expiry, `last_used_at` (throttled writes), and revocation.
A key acts with its creator's **current** role in its organization, intersected with its
scopes — removing the creator from the organization disables the key. Keys can never manage
keys, members, sharing, or delete datasets (session required).

## Uploads and malicious archives

Browsers upload directly to object storage with presigned multipart URLs (ADR-0005); the
API never buffers file bytes and caps request bodies at 1 MiB. The worker then:

1. Detects the format from **content** (magic bytes) and rejects extension mismatches.
2. Scans the raw upload with ClamAV (`MALWARE_SCANNER=clamav`), failing **closed**: scanner
   errors are retried, never treated as clean. With `none`, the version records
   `scan_status = skipped` (never “clean”).
3. Extracts with `packages/archive/src/extract.ts`, rejecting: absolute paths, drive letters,
   `..` traversal, control characters, symlinks, hardlinks, devices/FIFOs, encrypted
   entries, duplicate (case-insensitive) paths, too many files, per-file and total size
   limits measured on **actual bytes written** (not headers), compression ratio (zip
   bombs), nesting depth and path length. Files are written with `O_EXCL` into a fresh
   temp directory; partial output is deleted on any violation.
4. Parses YAML with the YAML 1.2 core schema (no custom tags, no code execution), an alias
   expansion cap (billion laughs) and a 256 KiB frontmatter cap.

Tests: `packages/archive/test/extract.test.ts` (hand-crafted hostile zip/tar archives),
malformed/alias-bomb fixtures, and zip-slip/non-OKF upload tests through the full pipeline.

## SSRF (URL imports)

`packages/archive/src/fetch.ts`: https only (http opt-in), no credentials in URLs,
optional host allow-list, internal hostnames rejected, and the IP check runs **inside the
socket's DNS lookup** so the address validated is the address connected to (no DNS
rebinding window). Blocks loopback, RFC 1918, CGNAT, link-local (incl. cloud metadata
169.254.169.254), multicast, reserved, IPv6 ULA/link-local, and IPv4-mapped / NAT64
encodings. Redirects are followed manually (max 3) and re-validated; size and time limits
apply. Imports run in the worker, never in the API.

## SQL injection and the query engine

- PostgreSQL: all queries use Drizzle parameter binding; dynamic identifiers use
  `sql.identifier` from fixed lists only.
- Structured queries compile against a column/operator whitelist with bound values
  (`packages/query/src/engine.ts`).
- Free SQL runs in a per-version **in-memory** DuckDB loaded from parquet, after
  `SET enable_external_access = false` and `SET lock_configuration = true`, with extension
  autoloading disabled, memory/thread limits, a row cap and a timeout that interrupts the
  query. Input must prepare as exactly one statement of type `SELECT`. Errors are scrubbed
  of file paths. Tests cover `COPY`, `ATTACH`, `INSTALL`, `SET`, multi-statements, and file
  and network reads via `read_csv`, `read_text`, `glob`, and HTTP URLs.

## XSS

Concept markdown is untrusted. It is rendered by `react-markdown` with `skipHtml` (raw HTML
dropped) and a URL allow-list (http/https/mailto and relative only — no `javascript:` or
`data:`); external links get `rel="noopener noreferrer nofollow"`. Search highlights use
control-character markers turned into React elements (no `dangerouslySetInnerHTML`
anywhere). CSV export neutralizes formula prefixes. The web app sends a strict CSP
(`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), `X-Frame-Options:
DENY`, `nosniff` and a strict referrer policy; the API sends `default-src 'none'` via Helmet.

## Rate limiting

`@fastify/rate-limit` with a shared Redis store: `RATE_LIMIT_MAX` per window per API key,
user, or IP; `AUTH_RATE_LIMIT_MAX` for signup/login/reset per IP. Responses include
`retry-after` and `x-ratelimit-*`. Set `TRUST_PROXY=true` behind a load balancer so client
IPs are correct.

## Secrets

No secrets are committed; `.env` is git-ignored, `.env.example` contains development
values only, and `docker-compose.prod.yml` refuses to start without required secrets. In
production use a secret manager (e.g. GCP Secret Manager / AWS Secrets Manager) and
workload identity for object storage where possible. Logs redact `authorization`, `cookie`,
`x-csrf-token`, `x-share-token` and `set-cookie`.

## Object storage permissions

The bucket is private (`mc anonymous set none`); all browser access is via short-lived
presigned URLs (upload parts: 1 h; downloads: 5 min with a sanitized
`Content-Disposition`). Bucket CORS must allow `PUT` from `WEB_ORIGIN` and expose `ETag`.
Enable object versioning or backups (see `deployment.md`). The service credentials need
only object read/write/delete and multipart permissions on this bucket.

## Data deletion

Deleting a dataset soft-deletes it immediately (invisible everywhere) and queues a purge
job that deletes version rows (explicitly bypassing the immutability guard with
`SET LOCAL okf.allow_purge = 'on'`), analytics parquet, the raw uploads, and blobs not
referenced by any other dataset. Deleting an organization queues a purge per dataset.
Database backups and bucket versioning retain data for their own retention periods —
document these in your privacy policy.

## Immutability and auditability

Processed versions are immutable, enforced by database triggers (`migrations/0001`,
`0002`): content columns cannot change, the only allowed status transition is
`VALIDATED → PUBLISHED`, and published versions cannot be deleted except by the purge job.
The audit log (`audit_logs`) records logins (including failures), logouts, password events,
organization/member/invitation changes, dataset lifecycle (create, update, upload,
version created/validated/failed, publish/unpublish, archive, visibility, delete,
download), SQL queries, grants, share links, API key creation/revocation and job
cancellation, with actor, API key, IP, user agent and request ID. Domain changes and their
audit rows are written in the same transaction.

## Dependency vulnerabilities

CI runs `npm audit --omit=dev --audit-level=high` (production dependencies: 0 known issues
at the time of writing). `npm audit` also reports moderate advisories in an old `esbuild`
pulled in by `drizzle-kit` — a dev-only migration generator that is never deployed. Install
scripts are blocked by default by npm 11 and allowed only for `esbuild` (`allowScripts` in
`package.json`). Keep Dependabot or Renovate enabled.

## Known limitations

- No MFA yet (TOTP/WebAuthn are natural additions via `auth_identities`).
- No email verification on signup; invitations are bound to the invited address.
- Malware scanning is off by default in development (`MALWARE_SCANNER=none`); enable
  ClamAV in production. ClamAV's `StreamMaxLength` must be ≥ `UPLOAD_MAX_BYTES`, or large
  uploads fail closed.
- The Next.js CSP allows `'unsafe-inline'` scripts (required by Next's inline bootstrap
  without nonce middleware).

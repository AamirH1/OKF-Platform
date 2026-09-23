# API
Versioned REST API under `/api/v1`; the full contract (schemas, auth, errors) is [openapi.yaml](openapi.yaml), generated from code and served at `/api/v1/openapi.json`.

- **Auth:** browser session cookie + `x-csrf-token` on mutations, or `Authorization: Bearer okf_…` API keys (scoped).
- **Errors:** `{ "error": { "code", "message", "requestId", "details?" } }`; 400 validation, 401, 403, 404 (also for invisible resources), 409 conflict/immutable, 408 query timeout, 413, 429 (`retry-after`).
- **Pagination:** `page`, `pageSize` (≤100) → `{ data, page: { page, pageSize, total } }`.
- **Rate limits:** `RATE_LIMIT_MAX`/window per key/user/IP; `AUTH_RATE_LIMIT_MAX` on auth routes.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/signup, /auth/login, /auth/logout, /auth/forgot-password, /auth/reset-password`, `GET/DELETE /auth/sessions` |
| Users | `GET/PATCH /users/me`, `POST /users/me/password` |
| Orgs | `/organizations[/:id]`, `/:id/members[/:userId]`, `/:id/invitations`, `POST /invitations/accept`, `/:id/audit-logs`, `/:id/tags` |
| Datasets | `/datasets[/:id]`, `POST /:id/publish, unpublish, archive, unarchive`, `PUT /:id/visibility`, `GET /:id/download`, `/:id/activity` |
| Uploads | `POST /datasets/:id/uploads`, `GET …/:uploadId` (resume), `POST …/:uploadId/complete`, `DELETE …/:uploadId`, `POST /datasets/:id/imports` |
| Versions | `/datasets/:id/versions[/:n]`, `/schema`, `/metadata`, `/validation`, `/files`, `/diff?base&target` |
| Preview | `/datasets/:id/preview`, `/concepts/*`, `/graph` |
| Query | `GET /datasets/:id/query/tables`, `POST /datasets/:id/query`, `POST /datasets/:id/query/sql` |
| Search | `GET /search?q&scope=datasets|concepts` |
| Sharing | `/datasets/:id/grants`, `/datasets/:id/share-links`, `GET /shared/:token` (then send `x-share-token`) |
| Keys/Jobs | `/api-keys`, `GET /jobs/:id`, `POST /jobs/:id/cancel` |
| Ops | `/health`, `/ready`, `/metrics` (unversioned) |

```bash
curl -H "Authorization: Bearer $OKF_KEY" http://localhost:4000/api/v1/datasets
curl -H "Authorization: Bearer $OKF_KEY" -H 'content-type: application/json' \
  -d '{"sql":"SELECT type, count(*) FROM concepts GROUP BY type"}' http://localhost:4000/api/v1/datasets/$ID/query/sql
```

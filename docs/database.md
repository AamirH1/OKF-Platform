# Database
PostgreSQL 17, Drizzle schema in `packages/db/src/schema.ts`, SQL migrations in `packages/db/migrations` (`0000` tables/indexes, `0001` immutability triggers, `0002` version search text).

| Brief's table | Implemented as |
|---|---|
| users, organizations, organization_members, api_keys, audit_logs, jobs, tags, dataset_tags | same names |
| datasets, dataset_versions, dataset_files | same names (files are content-addressed blobs) |
| dataset_metadata | `concepts` (one row per OKF concept, full frontmatter JSONB) + `dataset_versions.metadata/profile` |
| dataset_schemas | `dataset_versions.field_schema` (frontmatter fields) + `schema_columns` (parsed `# Schema`) |
| validation_runs, validation_errors | `validation_runs`, `validation_issues` (layer + severity) |
| extra | sessions, password_reset_tokens, auth_identities (OAuth-ready), invitations, dataset_grants, share_links, uploads, concept_links, version_diffs, dataset_usage_daily |

Conventions: UUID keys; `created_at/updated_at`; soft delete (`deleted_at`) for users, orgs, datasets with partial unique indexes; tenant `organization_id` on version-level tables; generated `tsvector` + GIN for search; partial indexes for the job queue. Processed versions are immutable via triggers; purge requires `SET LOCAL okf.allow_purge='on'`.
Workflow: edit schema → `npm run db:generate` → review SQL → `npm run db:migrate` (production: `node dist/migrate.js` in the API image, advisory-locked).

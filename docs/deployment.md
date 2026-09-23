# Deployment
Three stateless images from one [Dockerfile](../Dockerfile) (`--target api|worker|web`, non-root, health checks) plus PostgreSQL, Redis and S3-compatible storage. Run migrations as a release step before rolling out: `node dist/migrate.js` (API image).

## Single host (Docker Compose)
```bash
cp .env.example .env.production   # set POSTGRES_PASSWORD, REDIS_PASSWORD, S3_*, SMTP_URL, WEB_ORIGIN, S3_PUBLIC_ENDPOINT
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```
Put a TLS reverse proxy in front of `web` (and MinIO if browsers upload to it). Set `TRUST_PROXY=true`, `COOKIE_SECURE=auto` (Secure in production), `METRICS_TOKEN`, `MALWARE_SCANNER=clamav`.

## Google Cloud
- **web, api:** Cloud Run services (api min-instances ≥1; set `API_INTERNAL_URL` build arg to the api URL). **worker:** Cloud Run service with min-instances ≥1 and CPU always allocated (or GKE); scale by queue depth.
- **Postgres:** Cloud SQL 17 (private IP, automated backups + PITR). **Redis:** Memorystore.
- **Storage:** GCS via the S3-compatible XML API with HMAC keys (`S3_ENDPOINT=https://storage.googleapis.com`, `S3_FORCE_PATH_STYLE=false` if using virtual hosts); bucket CORS for PUT from `WEB_ORIGIN` exposing `ETag`; enable object versioning.
- **Secrets:** Secret Manager → env vars. **Logs/metrics:** Cloud Logging picks up pino JSON; scrape `/metrics` with Managed Prometheus.
- AWS equivalent: ECS/Fargate, RDS, ElastiCache, S3 (`S3_ENDPOINT` empty).

## Operations
- **Backups:** Postgres PITR/daily dumps (`pg_dump -Fc`), bucket versioning; test restores. Parquet analytics are derivable but stored alongside.
- **Health:** `/health` liveness, `/ready` readiness (DB, Redis, storage) on api (4000) and worker (4100).
- **Scaling:** API is stateless (DuckDB cache per instance, LRU); workers scale horizontally (`FOR UPDATE SKIP LOCKED`); crashed jobs are re-queued after `WORKER_STALE_AFTER_MS`.
- **CI/CD:** `.github/workflows/ci.yml` (lint, types, unit, OpenAPI drift, integration, Playwright E2E, audit, image builds); add a push/deploy job for your registry.

# syntax=docker/dockerfile:1.7
# Multi-target image: docker build --target api|worker|web -t okf-<target> .
# glibc base (not Alpine): DuckDB and Argon2 ship prebuilt glibc binaries.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# ── Install all workspace dependencies (cached on manifests only) ─────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/archive/package.json packages/archive/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/okf/package.json packages/okf/
COPY packages/query/package.json packages/query/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ── Build every service ──────────────────────────────────────────────────────
FROM deps AS build
# Next.js bakes rewrites and security headers in at build time.
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_S3_ORIGIN=http://localhost:9000
ENV API_INTERNAL_URL=${API_INTERNAL_URL} NEXT_PUBLIC_S3_ORIGIN=${NEXT_PUBLIC_S3_ORIGIN}
COPY . .
RUN npm run build -w @okf/db && npm run build -w @okf/api && npm run build -w @okf/worker && npm run build -w @okf/web

# ── Production-only node_modules for the Node services ───────────────────────
FROM deps AS prod-deps
RUN --mount=type=cache,target=/root/.npm npm prune --omit=dev --no-audit --no-fund

# ── API ──────────────────────────────────────────────────────────────────────
FROM base AS api
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
# Migrations ship with the API image; run `node dist/migrate.js` as a release step.
COPY --from=build /app/packages/db/migrations ./migrations
COPY --from=build /app/packages/db/dist/migrate.js ./dist/migrate.js
RUN mkdir -p /app/.cache/query && chown -R node:node /app/.cache
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.js"]

# ── Worker ───────────────────────────────────────────────────────────────────
FROM base AS worker
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist ./dist
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]

# ── Web (Next.js standalone output) ──────────────────────────────────────────
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

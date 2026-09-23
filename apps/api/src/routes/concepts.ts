import { z } from 'zod';
import { parseFrontmatter } from '@okf/core';
import { and, asc, conceptLinks, concepts, count, datasetFiles, desc, eq, ilike, or, type SQL, schemaColumns, sql } from '@okf/db';
import { conceptDetailSchema, conceptSummarySchema, pageSchema } from '@okf/shared';
import { notFound } from '../lib/errors';
import { authorizeDataset } from '../services/access';
import { resolveVersion } from '../services/datasets';
import { escapeLike } from '../services/search';
import { errorResponses, type RoutePlugin } from '../types';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const GRAPH_NODE_LIMIT = 3000;

type ConceptRow = typeof concepts.$inferSelect;
const summary = (c: ConceptRow, schemaColumnCount: number) => ({
  conceptId: c.conceptId,
  path: c.path,
  type: c.type,
  title: c.title,
  description: c.description,
  tags: c.tags,
  status: c.status,
  trustTier: c.trustTier,
  isStale: c.isStale,
  linkCount: c.linkCount,
  brokenLinkCount: c.brokenLinkCount,
  schemaColumnCount,
});

const SORTS = {
  concept_id: [asc(concepts.conceptId)],
  title: [asc(concepts.title), asc(concepts.conceptId)],
  type: [asc(concepts.type), asc(concepts.conceptId)],
  words: [desc(concepts.wordCount), asc(concepts.conceptId)],
  links: [desc(concepts.linkCount), asc(concepts.conceptId)],
} as const;

const routes: RoutePlugin = async (app, { deps }) => {
  app.get(
    '/datasets/:id/preview',
    {
      schema: {
        tags: ['preview'],
        summary: 'Paginated preview of a version\'s concepts with per-field statistics',
        description:
          'Records are OKF concepts; columns are frontmatter fields. Statistics are exact, computed over all concepts at processing time. ' +
          'Rows are paginated server-side; the whole bundle is never sent to the client.',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({
          version: z.coerce.number().int().min(1).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
          search: z.string().trim().max(200).optional(),
          type: z.string().max(120).optional(),
          trustTier: z.enum(['unverified', 'machine-confirmed', 'human-reviewed']).optional(),
          stale: z.enum(['true', 'false']).optional(),
          sort: z.enum(['concept_id', 'title', 'type', 'words', 'links']).default('concept_id'),
          shareToken: z.string().optional(),
        }),
        response: {
          200: z.object({
            version: z.number(),
            rowCount: z.number().nullable(),
            fileCount: z.number().nullable(),
            totalBytes: z.number().nullable(),
            columns: z.array(z.record(z.string(), z.unknown())),
            rows: pageSchema(conceptSummarySchema),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read');
      const v = await resolveVersion(deps, authz, req.query.version);
      const q = req.query;
      const where: SQL[] = [eq(concepts.versionId, v.id)];
      if (q.type) where.push(eq(concepts.type, q.type));
      if (q.trustTier) where.push(eq(concepts.trustTier, q.trustTier));
      if (q.stale) where.push(eq(concepts.isStale, q.stale === 'true'));
      if (q.search) {
        const like = `%${escapeLike(q.search)}%`;
        where.push(or(ilike(concepts.title, like), ilike(concepts.conceptId, like), sql`${concepts.search} @@ websearch_to_tsquery('english', ${q.search})`)!);
      }
      const cond = and(...where);
      const rows = await deps.db
        .select()
        .from(concepts)
        .where(cond)
        .orderBy(...SORTS[q.sort])
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      const [{ n }] = (await deps.db.select({ n: count() }).from(concepts).where(cond)) as [{ n: number }];
      const colCounts = rows.length
        ? await deps.db
            .select({ conceptId: schemaColumns.conceptId, n: count() })
            .from(schemaColumns)
            .where(and(eq(schemaColumns.versionId, v.id), sql`${schemaColumns.conceptId} IN (${sql.join(rows.map((r) => sql`${r.conceptId}`), sql`, `)})`))
            .groupBy(schemaColumns.conceptId)
        : [];
      const colMap = new Map(colCounts.map((c) => [c.conceptId, Number(c.n)]));
      const profile = v.profile as { fields?: Record<string, unknown>[] } | null;
      return {
        version: v.number,
        rowCount: v.conceptCount,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        columns: profile?.fields ?? [],
        rows: { data: rows.map((r) => summary(r, colMap.get(r.conceptId) ?? 0)), page: { page: q.page, pageSize: q.pageSize, total: Number(n) } },
      };
    },
  );

  app.get(
    '/datasets/:id/concepts/*',
    {
      schema: {
        tags: ['preview'],
        summary: 'One concept: frontmatter, body, links and parsed schema',
        params: z.object({ id: z.uuid(), '*': z.string().min(1).max(1024) }),
        querystring: z.object({ version: z.coerce.number().int().min(1).optional(), shareToken: z.string().optional() }),
        response: { 200: conceptDetailSchema, ...errorResponses },
      },
    },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read');
      const v = await resolveVersion(deps, authz, req.query.version);
      const conceptId = req.params['*'].replace(/\.md$/i, '');
      const [c] = await deps.db.select().from(concepts).where(and(eq(concepts.versionId, v.id), eq(concepts.conceptId, conceptId)));
      if (!c) throw notFound('Concept');
      const [file] = await deps.db.select().from(datasetFiles).where(and(eq(datasetFiles.versionId, v.id), eq(datasetFiles.path, c.path)));
      let body = '';
      if (file) {
        const text = (await deps.storage.getBuffer(file.storageKey, MAX_BODY_BYTES)).toString('utf8');
        const fm = parseFrontmatter(text);
        body = fm.kind === 'ok' || fm.kind === 'absent' ? fm.body : text;
      }
      const outbound = await deps.db.select().from(conceptLinks).where(and(eq(conceptLinks.versionId, v.id), eq(conceptLinks.sourceConceptId, conceptId))).orderBy(asc(conceptLinks.id));
      const inbound = await deps.db
        .selectDistinct({ sourceConceptId: conceptLinks.sourceConceptId, via: conceptLinks.via })
        .from(conceptLinks)
        .where(and(eq(conceptLinks.versionId, v.id), eq(conceptLinks.targetConceptId, conceptId), sql`${conceptLinks.sourceConceptId} <> ${conceptId}`))
        .orderBy(asc(conceptLinks.sourceConceptId));
      const cols = await deps.db.select().from(schemaColumns).where(and(eq(schemaColumns.versionId, v.id), eq(schemaColumns.conceptId, conceptId))).orderBy(asc(schemaColumns.ordinal));
      return {
        ...summary(c, cols.length),
        resource: c.resource,
        staleAfter: c.staleAfter,
        generatedBy: c.generatedBy,
        lastChangedAt: c.lastChangedAt,
        verifiedBy: c.verifiedBy,
        frontmatter: c.frontmatter as Record<string, unknown>,
        sources: c.sources as unknown[],
        computation: c.computation ?? null,
        headings: c.headings as { depth: number; text: string; line: number }[],
        body,
        outbound: outbound.map((l) => ({ raw: l.raw, kind: l.kind, targetConceptId: l.targetConceptId, targetPath: l.targetPath, broken: l.broken, via: l.via })),
        inbound,
        schema: cols.map((col) => ({ ordinal: col.ordinal, name: col.name, dataType: col.dataType, mode: col.mode, description: col.description })),
      };
    },
  );

  app.get(
    '/datasets/:id/graph',
    {
      schema: {
        tags: ['preview'],
        summary: 'Concept link graph (nodes = concepts, edges = resolved concept-to-concept links)',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ version: z.coerce.number().int().min(1).optional(), shareToken: z.string().optional() }),
        response: {
          200: z.object({
            version: z.number(),
            truncated: z.boolean(),
            nodes: z.array(z.object({ id: z.string(), title: z.string(), type: z.string(), trustTier: z.string(), isStale: z.boolean() })),
            edges: z.array(z.object({ source: z.string(), target: z.string() })),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read');
      const v = await resolveVersion(deps, authz, req.query.version);
      const nodes = await deps.db
        .select({ id: concepts.conceptId, title: concepts.title, type: concepts.type, trustTier: concepts.trustTier, isStale: concepts.isStale })
        .from(concepts)
        .where(eq(concepts.versionId, v.id))
        .orderBy(desc(concepts.linkCount), asc(concepts.conceptId))
        .limit(GRAPH_NODE_LIMIT + 1);
      const truncated = nodes.length > GRAPH_NODE_LIMIT;
      const kept = new Set(nodes.slice(0, GRAPH_NODE_LIMIT).map((n) => n.id));
      const edges = await deps.db
        .selectDistinct({ source: conceptLinks.sourceConceptId, target: conceptLinks.targetConceptId })
        .from(conceptLinks)
        .where(and(eq(conceptLinks.versionId, v.id), eq(conceptLinks.broken, false), sql`${conceptLinks.targetConceptId} IS NOT NULL`, sql`${conceptLinks.targetConceptId} <> ${conceptLinks.sourceConceptId}`));
      return {
        version: v.number,
        truncated,
        nodes: nodes.slice(0, GRAPH_NODE_LIMIT),
        edges: edges.filter((e): e is { source: string; target: string } => !!e.target && kept.has(e.source) && kept.has(e.target)),
      };
    },
  );
};

export default routes;

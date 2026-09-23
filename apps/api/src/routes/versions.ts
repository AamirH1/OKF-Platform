import { z } from 'zod';
import {
  and,
  asc,
  concepts,
  count,
  datasetFiles,
  datasetVersions,
  desc,
  enqueueJob,
  eq,
  jobs,
  schemaColumns,
  type SQL,
  sql,
  validationIssues,
  validationRuns,
  versionDiffs,
} from '@okf/db';
import { jobSchema, pageSchema, paginationSchema, validationReportSchema, versionSchema } from '@okf/shared';
import { AppError } from '../lib/errors';
import { authorizeDataset } from '../services/access';
import { jobDTO, resolveVersion, versionDTOs } from '../services/datasets';
import { errorResponses, type RoutePlugin } from '../types';

const idParam = z.object({ id: z.uuid() });
const versionQuery = z.object({ version: z.coerce.number().int().min(1).optional(), shareToken: z.string().optional() });

const routes: RoutePlugin = async (app, { deps }) => {
  app.get(
    '/datasets/:id/versions',
    { schema: { tags: ['versions'], summary: 'List versions (newest first)', params: idParam, querystring: paginationSchema.extend({ shareToken: z.string().optional() }), response: { 200: pageSchema(versionSchema), ...errorResponses } } },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read');
      const { page, pageSize } = req.query;
      // Public viewers only see the published version.
      const where = authz.can('dataset:read_drafts')
        ? eq(datasetVersions.datasetId, authz.dataset.id)
        : eq(datasetVersions.id, authz.dataset.publishedVersionId ?? '00000000-0000-0000-0000-000000000000');
      const rows = await deps.db.select().from(datasetVersions).where(where).orderBy(desc(datasetVersions.number)).limit(pageSize).offset((page - 1) * pageSize);
      const [{ n }] = (await deps.db.select({ n: count() }).from(datasetVersions).where(where)) as [{ n: number }];
      const dtos = await versionDTOs(deps, rows);
      return { data: rows.map((r) => dtos.get(r.id)!), page: { page, pageSize, total: Number(n) } };
    },
  );

  app.get(
    '/datasets/:id/versions/:number',
    { schema: { tags: ['versions'], params: z.object({ id: z.uuid(), number: z.coerce.number().int().min(1) }), querystring: z.object({ shareToken: z.string().optional() }), response: { 200: versionSchema, ...errorResponses } } },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read');
      const v = await resolveVersion(deps, authz, req.params.number);
      return (await versionDTOs(deps, [v])).get(v.id)!;
    },
  );

  app.get(
    '/datasets/:id/schema',
    {
      schema: {
        tags: ['versions'],
        summary: 'Schema of a version',
        description:
          '`fields`: frontmatter field schema inferred by the platform across all concepts (OKF defines only `type` as required). ' +
          '`assetSchemas`: columns parsed from `# Schema` sections — producer documentation of the assets the concepts describe, not enforced types.',
        params: idParam,
        querystring: versionQuery,
        response: {
          200: z.object({
            version: z.number(),
            fields: z.array(z.record(z.string(), z.unknown())),
            assetSchemas: z.array(
              z.object({
                conceptId: z.string(),
                title: z.string(),
                type: z.string(),
                columns: z.array(z.object({ ordinal: z.number(), name: z.string(), dataType: z.string().nullable(), mode: z.string().nullable(), description: z.string().nullable() })),
              }),
            ),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read');
      const v = await resolveVersion(deps, authz, req.query.version);
      const cols = await deps.db
        .select({ col: schemaColumns, title: concepts.title, type: concepts.type })
        .from(schemaColumns)
        .innerJoin(concepts, and(eq(concepts.versionId, schemaColumns.versionId), eq(concepts.conceptId, schemaColumns.conceptId)))
        .where(eq(schemaColumns.versionId, v.id))
        .orderBy(asc(schemaColumns.conceptId), asc(schemaColumns.ordinal));
      const byConcept = new Map<string, { conceptId: string; title: string; type: string; columns: { ordinal: number; name: string; dataType: string | null; mode: string | null; description: string | null }[] }>();
      for (const r of cols) {
        const entry = byConcept.get(r.col.conceptId) ?? { conceptId: r.col.conceptId, title: r.title, type: r.type, columns: [] };
        entry.columns.push({ ordinal: r.col.ordinal, name: r.col.name, dataType: r.col.dataType, mode: r.col.mode, description: r.col.description });
        byConcept.set(r.col.conceptId, entry);
      }
      return { version: v.number, fields: (v.fieldSchema as Record<string, unknown>[] | null) ?? [], assetSchemas: [...byConcept.values()] };
    },
  );

  app.get(
    '/datasets/:id/metadata',
    {
      schema: {
        tags: ['versions'],
        summary: 'Bundle metadata and profile of a version',
        params: idParam,
        querystring: versionQuery,
        response: { 200: z.object({ version: z.number(), okfVersion: z.string().nullable(), metadata: z.unknown(), profile: z.unknown() }), ...errorResponses },
      },
    },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read');
      const v = await resolveVersion(deps, authz, req.query.version);
      return { version: v.number, okfVersion: v.okfVersion, metadata: v.metadata ?? null, profile: v.profile ?? null };
    },
  );

  app.get(
    '/datasets/:id/validation',
    {
      schema: {
        tags: ['versions'],
        summary: 'Validation report (OKF structural conformance + platform quality checks)',
        params: idParam,
        querystring: versionQuery.extend(paginationSchema.shape).extend({
          severity: z.enum(['error', 'warning', 'info']).optional(),
          layer: z.enum(['structural', 'quality']).optional(),
          code: z.string().max(64).optional(),
          path: z.string().max(1024).optional(),
        }),
        response: { 200: validationReportSchema, ...errorResponses },
      },
    },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read');
      const v = await resolveVersion(deps, authz, req.query.version);
      const [run] = await deps.db.select().from(validationRuns).where(eq(validationRuns.versionId, v.id)).orderBy(desc(validationRuns.finishedAt)).limit(1);
      const failure = (v.failure as { code: string; message: string; stage?: string | null } | null) ?? null;
      const empty = { data: [], page: { page: req.query.page, pageSize: req.query.pageSize, total: 0 } };
      if (!run) {
        return {
          version: v.number,
          valid: v.valid,
          specVersion: null,
          validatorVersion: null,
          counts: { errors: 0, warnings: 0, infos: 0 },
          suppressed: {},
          byCode: [],
          failure: failure ? { ...failure, stage: failure.stage ?? null } : null,
          issues: empty,
        };
      }
      const where: SQL[] = [eq(validationIssues.runId, run.id)];
      if (req.query.severity) where.push(eq(validationIssues.severity, req.query.severity));
      if (req.query.layer) where.push(eq(validationIssues.layer, req.query.layer));
      if (req.query.code) where.push(eq(validationIssues.code, req.query.code));
      if (req.query.path) where.push(eq(validationIssues.path, req.query.path));
      const cond = and(...where);
      const { page, pageSize } = req.query;
      const rows = await deps.db
        .select()
        .from(validationIssues)
        .where(cond)
        .orderBy(sql`CASE ${validationIssues.severity} WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`, asc(validationIssues.path), asc(validationIssues.line), asc(validationIssues.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [{ n }] = (await deps.db.select({ n: count() }).from(validationIssues).where(cond)) as [{ n: number }];
      const byCode = await deps.db
        .select({ code: validationIssues.code, severity: validationIssues.severity, layer: validationIssues.layer, count: count() })
        .from(validationIssues)
        .where(eq(validationIssues.runId, run.id))
        .groupBy(validationIssues.code, validationIssues.severity, validationIssues.layer)
        .orderBy(desc(count()));
      return {
        version: v.number,
        valid: run.valid,
        specVersion: run.specVersion,
        validatorVersion: run.validatorVersion,
        counts: { errors: run.errorCount, warnings: run.warningCount, infos: run.infoCount },
        suppressed: run.suppressed as Record<string, number>,
        byCode: byCode.map((b) => ({ ...b, count: Number(b.count) })),
        failure: failure ? { ...failure, stage: failure.stage ?? null } : null,
        issues: {
          data: rows.map((i) => ({
            code: i.code,
            message: i.message,
            severity: i.severity,
            layer: i.layer,
            location: { path: i.path, line: i.line, column: i.column },
            field: i.field,
          })),
          page: { page, pageSize, total: Number(n) },
        },
      };
    },
  );

  app.get(
    '/datasets/:id/files',
    {
      schema: {
        tags: ['versions'],
        summary: 'Files of a version',
        params: idParam,
        querystring: versionQuery.extend(paginationSchema.shape).extend({ pageSize: z.coerce.number().int().min(1).max(1000).default(200) }),
        response: {
          200: z.object({
            version: z.number(),
            data: z.array(z.object({ path: z.string(), kind: z.string(), size: z.number(), sha256: z.string() })),
            page: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read');
      const v = await resolveVersion(deps, authz, req.query.version);
      const { page, pageSize } = req.query;
      const rows = await deps.db
        .select({ path: datasetFiles.path, kind: datasetFiles.kind, size: datasetFiles.size, sha256: datasetFiles.sha256 })
        .from(datasetFiles)
        .where(eq(datasetFiles.versionId, v.id))
        .orderBy(asc(datasetFiles.path))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [{ n }] = (await deps.db.select({ n: count() }).from(datasetFiles).where(eq(datasetFiles.versionId, v.id))) as [{ n: number }];
      return { version: v.number, data: rows, page: { page, pageSize, total: Number(n) } };
    },
  );

  app.get(
    '/datasets/:id/diff',
    {
      schema: {
        tags: ['versions'],
        summary: 'Compare two versions',
        description:
          'Returns the cached comparison (200) or queues a `diff_versions` job (202) — poll the job, then call again. ' +
          '`exact` sections compare every concept; `statistical` sections are deltas of whole-version aggregates.',
        params: idParam,
        querystring: z.object({ base: z.coerce.number().int().min(1), target: z.coerce.number().int().min(1) }),
        response: { 200: z.object({ base: z.number(), target: z.number(), diff: z.unknown() }), 202: z.object({ job: jobSchema }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read_drafts');
      if (req.query.base === req.query.target) throw new AppError(400, 'BAD_REQUEST', 'Choose two different versions.');
      const base = await resolveVersion(deps, authz, req.query.base);
      const target = await resolveVersion(deps, authz, req.query.target);
      for (const v of [base, target]) {
        if (v.status !== 'VALIDATED' && v.status !== 'PUBLISHED') throw new AppError(409, 'NOT_READY', `Version ${v.number} is ${v.status} and cannot be compared.`);
      }
      const [cached] = await deps.db
        .select()
        .from(versionDiffs)
        .where(and(eq(versionDiffs.baseVersionId, base.id), eq(versionDiffs.targetVersionId, target.id)));
      if (cached) return { base: base.number, target: target.number, diff: cached.result };
      // Reuse a pending job for the same pair instead of queueing duplicates.
      const [pending] = await deps.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.type, 'diff_versions'),
            eq(jobs.datasetId, authz.dataset.id),
            sql`${jobs.status} IN ('QUEUED', 'RUNNING')`,
            sql`${jobs.payload}->>'baseVersionId' = ${base.id}`,
            sql`${jobs.payload}->>'targetVersionId' = ${target.id}`,
          ),
        );
      const job =
        pending ??
        (await enqueueJob(deps.db, {
          type: 'diff_versions',
          organizationId: authz.dataset.organizationId,
          datasetId: authz.dataset.id,
          createdBy: req.auth.user?.id ?? null,
          payload: { baseVersionId: base.id, targetVersionId: target.id },
        }));
      return reply.code(202).send({ job: jobDTO(job) });
    },
  );
};

export default routes;

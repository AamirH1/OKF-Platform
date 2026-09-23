import { z } from 'zod';
import {
  and,
  asc,
  count,
  datasets,
  datasetTags,
  datasetVersions,
  desc,
  enqueueJob,
  eq,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
  recordUsage,
  refreshDatasetStatus,
  type SQL,
  sql,
  tags,
} from '@okf/db';
import {
  createDatasetSchema,
  datasetSchema,
  listDatasetsQuerySchema,
  pageSchema,
  updateDatasetSchema,
  visibilitySchema,
} from '@okf/shared';
import { audit } from '../lib/audit';
import { AppError, conflict } from '../lib/errors';
import { requireSession, requireUser } from '../plugins/auth';
import { authorizeDataset, authorizeOrg } from '../services/access';
import {
  datasetDTO,
  datasetDTOs,
  listAuthz,
  resolveVersion,
  setDatasetTags,
  slugify,
  uniqueDatasetSlug,
  viewerContext,
} from '../services/datasets';
import { escapeLike, visibleDatasetSql } from '../services/search';
import { errorResponses, type RoutePlugin, uuidParam } from '../types';

const routes: RoutePlugin = async (app, { deps }) => {
  app.get(
    '/datasets',
    {
      schema: {
        tags: ['datasets'],
        summary: 'List datasets visible to the caller',
        description: 'Anonymous callers see public, published datasets. Filtering and pagination happen server-side.',
        querystring: listDatasetsQuerySchema,
        response: { 200: pageSchema(datasetSchema), ...errorResponses },
      },
    },
    async (req) => {
      const q = req.query;
      const viewer = { userId: req.auth.user?.id ?? null, restrictToOrgId: req.auth.apiKey?.organizationId ?? null };
      const where: SQL[] = [visibleDatasetSql(viewer)];
      if (q.organizationId) where.push(sql`d.organization_id = ${q.organizationId}`);
      if (q.status) where.push(sql`d.status = ${q.status}`);
      if (q.visibility) where.push(sql`d.visibility = ${q.visibility}`);
      if (q.tag) where.push(sql`EXISTS (SELECT 1 FROM dataset_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.dataset_id = d.id AND t.name = ${q.tag})`);
      if (q.q) where.push(sql`(d.name ILIKE ${`%${escapeLike(q.q)}%`} OR d.search @@ websearch_to_tsquery('english', ${q.q}))`);
      const order = q.sort === 'name' ? sql`d.name ASC` : q.sort === 'created' ? sql`d.created_at DESC` : sql`d.updated_at DESC`;
      const cond = sql.join(where, sql` AND `);
      const idRows = await deps.db.execute<{ id: string }>(
        sql`SELECT d.id FROM datasets d WHERE ${cond} ORDER BY ${order}, d.id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      );
      const totalRows = await deps.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM datasets d WHERE ${cond}`);
      const ids = idRows.rows.map((r) => r.id);
      const rows = ids.length ? await deps.db.select().from(datasets).where(sql`${datasets.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`) : [];
      const ordered = ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
      const ctx = await viewerContext(deps, req.auth.principal, req.auth.apiKey, req.auth.session ? (req.auth.user?.id ?? null) : null);
      return { data: await datasetDTOs(deps, ordered, listAuthz(ctx)), page: { page: q.page, pageSize: q.pageSize, total: Number(totalRows.rows[0]?.n ?? 0) } };
    },
  );

  app.post(
    '/datasets',
    { schema: { tags: ['datasets'], summary: 'Create a dataset (no versions yet: status DRAFT)', body: createDatasetSchema, response: { 201: datasetSchema, ...errorResponses } } },
    async (req, reply) => {
      const user = requireUser(req);
      const b = req.body;
      await authorizeOrg(deps, req, b.organizationId, 'datasets:create');
      const slug = b.slug ?? (await uniqueDatasetSlug(deps, b.organizationId, slugify(b.name)));
      let id: string;
      try {
        id = await deps.db.transaction(async (tx) => {
          const [d] = await tx
            .insert(datasets)
            .values({ organizationId: b.organizationId, slug, name: b.name, description: b.description, license: b.license ?? null, visibility: b.visibility, createdBy: user.id })
            .returning();
          await setDatasetTags(tx, b.organizationId, d!.id, b.tags);
          await audit(tx, req, { action: 'dataset.created', organizationId: b.organizationId, resourceType: 'dataset', resourceId: d!.id, metadata: { name: b.name, slug, visibility: b.visibility } });
          return d!.id;
        });
      } catch (e) {
        if (pgErrorCode(e) === PG_UNIQUE_VIOLATION) throw conflict(`A dataset with slug "${slug}" already exists in this organization.`, 'SLUG_TAKEN');
        throw e;
      }
      const authz = await authorizeDataset(deps, req, id, 'dataset:read');
      return reply.code(201).send(await datasetDTO(deps, authz));
    },
  );

  app.get('/datasets/:id', { schema: { tags: ['datasets'], params: uuidParam, response: { 200: datasetSchema, ...errorResponses } } }, async (req) => {
    const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:read');
    await recordUsage(deps.db, authz.dataset.id, req.auth.apiKey ? 'api_requests' : 'views');
    return datasetDTO(deps, authz);
  });

  app.patch(
    '/datasets/:id',
    { schema: { tags: ['datasets'], summary: 'Update dataset metadata and tags', params: uuidParam, body: updateDatasetSchema, response: { 200: datasetSchema, ...errorResponses } } },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:update');
      const b = req.body;
      await deps.db.transaction(async (tx) => {
        const set: Partial<typeof datasets.$inferInsert> = { updatedAt: new Date() };
        if (b.name !== undefined) set.name = b.name;
        if (b.description !== undefined) set.description = b.description;
        if (b.license !== undefined) set.license = b.license;
        await tx.update(datasets).set(set).where(eq(datasets.id, authz.dataset.id));
        if (b.tags) await setDatasetTags(tx, authz.dataset.organizationId, authz.dataset.id, b.tags);
        await audit(tx, req, { action: 'dataset.updated', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id, metadata: { fields: Object.keys(b) } });
      });
      return datasetDTO(deps, (await authorizeDataset(deps, req, req.params.id, 'dataset:read')));
    },
  );

  app.delete(
    '/datasets/:id',
    {
      schema: {
        tags: ['datasets'],
        summary: 'Delete a dataset',
        description: 'Soft-deletes immediately (invisible everywhere); a background job purges stored files and version data.',
        params: uuidParam,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      requireSession(req);
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:delete');
      await deps.db.transaction(async (tx) => {
        await tx.update(datasets).set({ deletedAt: new Date(), publishedVersionId: null }).where(eq(datasets.id, authz.dataset.id));
        await enqueueJob(tx, { type: 'purge_dataset', organizationId: authz.dataset.organizationId, datasetId: authz.dataset.id, createdBy: req.auth.user?.id ?? null });
        await audit(tx, req, { action: 'dataset.deleted', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id, metadata: { name: authz.dataset.name } });
      });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/datasets/:id/publish',
    {
      schema: {
        tags: ['datasets'],
        summary: 'Publish a validated version',
        description: 'Defaults to the newest version. Only conformant (valid) versions can be published; the published version becomes immutable.',
        params: uuidParam,
        body: z.object({ version: z.number().int().min(1).optional() }).default({}),
        response: { 200: datasetSchema, ...errorResponses },
      },
    },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:publish');
      const v = await resolveVersion(deps, authz, req.body.version);
      if (req.body.version === undefined && v.id !== authz.dataset.latestVersionId) {
        throw new AppError(409, 'NOT_PUBLISHABLE', 'The newest version is not validated yet; pass an explicit version number to publish an older one.');
      }
      if (v.status !== 'VALIDATED' && v.status !== 'PUBLISHED') {
        throw new AppError(409, 'NOT_PUBLISHABLE', `Version ${v.number} is ${v.status}; only validated versions can be published.`);
      }
      if (v.valid !== true) throw new AppError(409, 'NOT_PUBLISHABLE', `Version ${v.number} is not OKF-conformant.`);
      await deps.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM ${datasets} WHERE id = ${authz.dataset.id} FOR UPDATE`);
        if (v.status === 'VALIDATED') {
          await tx.update(datasetVersions).set({ status: 'PUBLISHED', publishedAt: new Date(), publishedBy: req.auth.user?.id ?? null }).where(eq(datasetVersions.id, v.id));
        }
        await tx.update(datasets).set({ publishedVersionId: v.id }).where(eq(datasets.id, authz.dataset.id));
        await refreshDatasetStatus(tx, authz.dataset.id);
        await audit(tx, req, {
          action: 'dataset.published',
          organizationId: authz.dataset.organizationId,
          resourceType: 'dataset',
          resourceId: authz.dataset.id,
          metadata: { version: v.number, versionId: v.id, visibility: authz.dataset.visibility },
        });
      });
      return datasetDTO(deps, await authorizeDataset(deps, req, req.params.id, 'dataset:read'));
    },
  );

  app.post(
    '/datasets/:id/unpublish',
    { schema: { tags: ['datasets'], summary: 'Stop serving the published version (the version itself stays immutable)', params: uuidParam, response: { 200: datasetSchema, ...errorResponses } } },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:publish');
      if (!authz.dataset.publishedVersionId) throw new AppError(409, 'NOT_PUBLISHED', 'The dataset is not published.');
      await deps.db.transaction(async (tx) => {
        await tx.update(datasets).set({ publishedVersionId: null }).where(eq(datasets.id, authz.dataset.id));
        await refreshDatasetStatus(tx, authz.dataset.id);
        await audit(tx, req, { action: 'dataset.unpublished', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id });
      });
      return datasetDTO(deps, await authorizeDataset(deps, req, req.params.id, 'dataset:read'));
    },
  );

  for (const [path, archived] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/datasets/:id/${path}`, { schema: { tags: ['datasets'], summary: archived ? 'Archive (read-only)' : 'Unarchive', params: uuidParam, response: { 200: datasetSchema, ...errorResponses } } }, async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:archive');
      await deps.db.transaction(async (tx) => {
        await tx.update(datasets).set({ archivedAt: archived ? new Date() : null }).where(eq(datasets.id, authz.dataset.id));
        await refreshDatasetStatus(tx, authz.dataset.id);
        await audit(tx, req, { action: archived ? 'dataset.archived' : 'dataset.unarchived', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id });
      });
      return datasetDTO(deps, await authorizeDataset(deps, req, req.params.id, 'dataset:read'));
    });
  }

  app.put(
    '/datasets/:id/visibility',
    { schema: { tags: ['sharing'], summary: 'Set visibility: private | organization | public', params: uuidParam, body: visibilitySchema, response: { 200: datasetSchema, ...errorResponses } } },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:share');
      await deps.db.transaction(async (tx) => {
        await tx.update(datasets).set({ visibility: req.body.visibility, updatedAt: new Date() }).where(eq(datasets.id, authz.dataset.id));
        await audit(tx, req, {
          action: 'dataset.visibility_changed',
          organizationId: authz.dataset.organizationId,
          resourceType: 'dataset',
          resourceId: authz.dataset.id,
          metadata: { from: authz.dataset.visibility, to: req.body.visibility },
        });
      });
      return datasetDTO(deps, await authorizeDataset(deps, req, req.params.id, 'dataset:read'));
    },
  );

  app.get(
    '/datasets/:id/download',
    {
      schema: {
        tags: ['datasets'],
        summary: 'Short-lived URL for the original uploaded archive of a version',
        params: uuidParam,
        querystring: z.object({ version: z.coerce.number().int().min(1).optional(), shareToken: z.string().optional() }),
        response: { 200: z.object({ url: z.string(), expiresInSeconds: z.number(), filename: z.string(), sha256: z.string().nullable() }), ...errorResponses },
      },
    },
    async (req) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:download');
      const v = await resolveVersion(deps, authz, req.query.version);
      if (v.status === 'PROCESSING' || !v.archiveSha256) throw new AppError(409, 'NOT_READY', 'This version is still processing.');
      if (v.scanStatus === 'infected') throw new AppError(409, 'INFECTED', 'This upload was flagged by malware scanning and cannot be downloaded.');
      const filename = `${authz.dataset.slug}-v${v.number}-${v.originalFilename}`;
      const expiresInSeconds = 300;
      const url = await deps.storage.presignGet(v.archiveKey, expiresInSeconds, filename);
      await recordUsage(deps.db, authz.dataset.id, 'downloads');
      await audit(deps.db, req, { action: 'dataset.downloaded', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id, metadata: { version: v.number } });
      return { url, expiresInSeconds, filename, sha256: v.archiveSha256 };
    },
  );

  app.get(
    '/organizations/:id/tags',
    { schema: { tags: ['datasets'], summary: 'Tags used in an organization', params: uuidParam, response: { 200: z.object({ data: z.array(z.object({ name: z.string(), count: z.number() })) }), ...errorResponses } } },
    async (req) => {
      await authorizeOrg(deps, req, req.params.id, 'org:read');
      const rows = await deps.db
        .select({ name: tags.name, count: count(datasetTags.datasetId) })
        .from(tags)
        .leftJoin(datasetTags, eq(datasetTags.tagId, tags.id))
        .leftJoin(datasets, and(eq(datasets.id, datasetTags.datasetId), sql`${datasets.deletedAt} IS NULL`))
        .where(eq(tags.organizationId, req.params.id))
        .groupBy(tags.name)
        .orderBy(desc(count(datasetTags.datasetId)), asc(tags.name));
      return { data: rows.map((r) => ({ name: r.name, count: Number(r.count) })) };
    },
  );
};

export default routes;

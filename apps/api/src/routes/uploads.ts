import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq, uploads } from '@okf/db';
import { completeUploadSchema, createUploadSchema, importUrlSchema, uploadSessionSchema, versionSchema } from '@okf/shared';
import { storageKeys } from '@okf/storage';
import type { AppDeps } from '../deps';
import { audit } from '../lib/audit';
import { AppError, badRequest, notFound } from '../lib/errors';
import { checkImportUrlSyntax, UrlGuardError } from '@okf/archive';
import { authorizeDataset } from '../services/access';
import { versionDTO } from '../services/datasets';
import { createVersionWithJob } from '../services/versions';
import { errorResponses, type RoutePlugin } from '../types';

const MAX_PARTS = 10_000;
const PART_URL_TTL_SECONDS = 3600;
const uploadParams = z.object({ id: z.uuid(), uploadId: z.uuid() });
type UploadRow = typeof uploads.$inferSelect;

async function sessionDTO(deps: AppDeps, up: UploadRow) {
  const completedParts = await deps.storage.listParts(up.storageKey, up.s3UploadId);
  const done = new Set(completedParts.map((p) => p.partNumber));
  const parts = await Promise.all(
    Array.from({ length: up.partCount }, (_, i) => i + 1)
      .filter((n) => !done.has(n))
      .map(async (partNumber) => ({ partNumber, url: await deps.storage.presignUploadPart(up.storageKey, up.s3UploadId, partNumber, PART_URL_TTL_SECONDS) })),
  );
  return { uploadId: up.id, partSize: up.partSize, partCount: up.partCount, expiresAt: up.expiresAt.toISOString(), parts, completedParts };
}

const routes: RoutePlugin = async (app, { deps }) => {
  const { env } = deps;

  app.post(
    '/datasets/:id/uploads',
    {
      schema: {
        tags: ['uploads'],
        summary: 'Start a direct-to-storage multipart upload',
        description:
          'Returns presigned PUT URLs, one per part. PUT each part to its URL, collect the ETag response headers, then call `complete`. ' +
          'File bytes never pass through the API.',
        params: z.object({ id: z.uuid() }),
        body: createUploadSchema,
        response: { 201: uploadSessionSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:upload');
      const { filename, size, contentType, notes } = req.body;
      if (size > env.UPLOAD_MAX_BYTES) {
        throw new AppError(413, 'FILE_TOO_LARGE', `Uploads are limited to ${Math.floor(env.UPLOAD_MAX_BYTES / 1024 / 1024)} MiB.`);
      }
      const partSize = Math.max(env.UPLOAD_PART_SIZE_BYTES, Math.ceil(size / MAX_PARTS));
      const partCount = Math.max(1, Math.ceil(size / partSize));
      const id = randomUUID();
      const key = storageKeys.upload(authz.dataset.organizationId, id);
      const s3UploadId = await deps.storage.createMultipartUpload(key, contentType);
      const [up] = await deps.db
        .insert(uploads)
        .values({
          id,
          organizationId: authz.dataset.organizationId,
          datasetId: authz.dataset.id,
          createdBy: req.auth.user?.id ?? null,
          filename,
          size,
          contentType,
          storageKey: key,
          s3UploadId,
          partSize,
          partCount,
          notes,
          expiresAt: new Date(Date.now() + env.UPLOAD_SESSION_TTL_HOURS * 3_600_000),
        })
        .returning();
      deps.metrics.uploadsInitiated.inc();
      await audit(deps.db, req, { action: 'upload.created', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id, metadata: { uploadId: id, filename, size } });
      return reply.code(201).send(await sessionDTO(deps, up!));
    },
  );

  const loadUpload = async (datasetId: string, uploadId: string) => {
    const [up] = await deps.db.select().from(uploads).where(and(eq(uploads.id, uploadId), eq(uploads.datasetId, datasetId)));
    if (!up) throw notFound('Upload');
    return up;
  };

  app.get(
    '/datasets/:id/uploads/:uploadId',
    { schema: { tags: ['uploads'], summary: 'Resume an upload: fresh URLs for missing parts', params: uploadParams, response: { 200: uploadSessionSchema, ...errorResponses } } },
    async (req) => {
      await authorizeDataset(deps, req, req.params.id, 'dataset:upload');
      const up = await loadUpload(req.params.id, req.params.uploadId);
      if (up.status !== 'INITIATED' || up.expiresAt <= new Date()) throw new AppError(409, 'UPLOAD_CLOSED', `Upload is ${up.status.toLowerCase()}.`);
      return sessionDTO(deps, up);
    },
  );

  app.post(
    '/datasets/:id/uploads/:uploadId/complete',
    {
      schema: {
        tags: ['uploads'],
        summary: 'Finish an upload and start processing',
        description: 'Creates the next immutable version (status PROCESSING) and queues its ingestion job.',
        params: uploadParams,
        body: completeUploadSchema,
        response: { 201: versionSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:upload');
      const up = await loadUpload(req.params.id, req.params.uploadId);
      if (up.status !== 'INITIATED') throw new AppError(409, 'UPLOAD_CLOSED', `Upload is ${up.status.toLowerCase()}.`);
      const numbers = req.body.parts.map((p) => p.partNumber);
      if (new Set(numbers).size !== up.partCount || numbers.some((n) => n > up.partCount)) {
        throw badRequest(`Expected parts 1..${up.partCount} exactly once.`);
      }
      // Retry-safe: a previous attempt may have completed the multipart upload in storage
      // and then failed before the database transaction committed.
      let head = await deps.storage.head(up.storageKey);
      if (!head) {
        try {
          await deps.storage.completeMultipartUpload(up.storageKey, up.s3UploadId, req.body.parts);
        } catch (err) {
          deps.metrics.uploadFailures.labels('complete').inc();
          req.log.warn({ err }, 'multipart completion failed');
          throw new AppError(400, 'UPLOAD_INCOMPLETE', 'Storage rejected the upload; some parts are missing or their ETags do not match. Resume and retry.');
        }
        head = await deps.storage.head(up.storageKey);
      }
      if (!head || head.size !== up.size) {
        deps.metrics.uploadFailures.labels('size_mismatch').inc();
        throw new AppError(400, 'SIZE_MISMATCH', `Uploaded ${head?.size ?? 0} bytes but ${up.size} were declared.`);
      }
      const { version, job } = await deps.db.transaction(async (tx) => {
        const [locked] = await tx.update(uploads).set({ status: 'COMPLETED', completedAt: new Date() }).where(and(eq(uploads.id, up.id), eq(uploads.status, 'INITIATED'))).returning();
        if (!locked) throw new AppError(409, 'UPLOAD_CLOSED', 'Upload was already completed.');
        const created = await createVersionWithJob(tx, {
          datasetId: authz.dataset.id,
          organizationId: authz.dataset.organizationId,
          createdBy: req.auth.user?.id ?? null,
          sourceType: 'upload',
          sourceUrl: null,
          originalFilename: up.filename,
          archiveKey: up.storageKey,
          archiveSize: up.size,
          notes: up.notes,
        });
        await tx.update(uploads).set({ versionId: created.version.id }).where(eq(uploads.id, up.id));
        await audit(tx, req, {
          action: 'version.created',
          organizationId: authz.dataset.organizationId,
          resourceType: 'dataset',
          resourceId: authz.dataset.id,
          metadata: { version: created.version.number, versionId: created.version.id, jobId: created.job.id, filename: up.filename, size: up.size },
        });
        return created;
      });
      const user = req.auth.user;
      return reply.code(201).send(versionDTO(version, user ? { id: user.id, name: user.name } : null, job));
    },
  );

  app.delete(
    '/datasets/:id/uploads/:uploadId',
    { schema: { tags: ['uploads'], summary: 'Cancel an in-progress upload', params: uploadParams, response: { 204: z.null(), ...errorResponses } } },
    async (req, reply) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:upload');
      const up = await loadUpload(req.params.id, req.params.uploadId);
      if (up.status === 'INITIATED') {
        await deps.storage.abortMultipartUpload(up.storageKey, up.s3UploadId);
        await deps.db.update(uploads).set({ status: 'ABORTED' }).where(eq(uploads.id, up.id));
        await audit(deps.db, req, { action: 'upload.aborted', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id, metadata: { uploadId: up.id } });
      }
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/datasets/:id/imports',
    {
      schema: {
        tags: ['uploads'],
        summary: 'Import a bundle archive from an HTTPS URL',
        description: 'The worker downloads the file behind an SSRF guard (public addresses only, size and time limits, no redirects to private networks).',
        params: z.object({ id: z.uuid() }),
        body: importUrlSchema,
        response: { 202: versionSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:upload');
      let url: URL;
      try {
        url = checkImportUrlSyntax(req.body.url, { allowHttp: env.IMPORT_ALLOW_HTTP, allowedHosts: env.IMPORT_ALLOWED_HOSTS, allowPrivate: env.IMPORT_ALLOW_PRIVATE_NETWORKS });
      } catch (e) {
        if (e instanceof UrlGuardError) throw badRequest(e.message);
        throw e;
      }
      const filename = req.body.filename || decodeURIComponent(url.pathname.split('/').pop() || '') || 'import.zip';
      const { version, job } = await deps.db.transaction(async (tx) => {
        const created = await createVersionWithJob(tx, {
          datasetId: authz.dataset.id,
          organizationId: authz.dataset.organizationId,
          createdBy: req.auth.user?.id ?? null,
          sourceType: 'import',
          sourceUrl: url.toString(),
          originalFilename: filename.slice(0, 255),
          archiveKey: storageKeys.upload(authz.dataset.organizationId, randomUUID()),
          archiveSize: null,
          notes: req.body.notes,
        });
        await audit(tx, req, {
          action: 'version.created',
          organizationId: authz.dataset.organizationId,
          resourceType: 'dataset',
          resourceId: authz.dataset.id,
          metadata: { version: created.version.number, versionId: created.version.id, jobId: created.job.id, importUrl: url.toString() },
        });
        return created;
      });
      const user = req.auth.user;
      return reply.code(202).send(versionDTO(version, user ? { id: user.id, name: user.name } : null, job));
    },
  );
};

export default routes;

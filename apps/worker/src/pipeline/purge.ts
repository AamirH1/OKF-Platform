import { and, datasetFiles, datasets, datasetVersions, eq, inArray, isNotNull, sql, uploads } from '@okf/db';
import { storageKeys } from '@okf/storage';
import { JobFailure, type JobHandler, type WorkerDeps } from '../context';

/**
 * Permanently remove a soft-deleted dataset: its version rows (bypassing the immutability
 * guard explicitly), analytics artifacts, raw uploads, and blobs no other dataset uses.
 */
export function purgeHandler(deps: WorkerDeps): JobHandler {
  const { db, storage } = deps;
  return {
    async run(ctx) {
      const datasetId = ctx.job.datasetId;
      if (!datasetId) throw new JobFailure('BAD_JOB', 'Purge job has no dataset.');
      const [d] = await db.select().from(datasets).where(and(eq(datasets.id, datasetId), isNotNull(datasets.deletedAt)));
      if (!d) return { skipped: 'dataset is not deleted' };
      await ctx.progress('collect', 10);
      const versions = await db.select().from(datasetVersions).where(eq(datasetVersions.datasetId, datasetId));
      const versionIds = versions.map((v) => v.id);
      const blobs = versionIds.length ? await db.selectDistinct({ key: datasetFiles.storageKey }).from(datasetFiles).where(inArray(datasetFiles.versionId, versionIds)) : [];
      // Blobs are deduplicated per organization; only delete those no other surviving version references.
      const orphaned: string[] = [];
      for (const { key } of blobs) {
        const [other] = await db
          .select({ id: datasetFiles.id })
          .from(datasetFiles)
          .innerJoin(datasetVersions, eq(datasetVersions.id, datasetFiles.versionId))
          .where(and(eq(datasetFiles.storageKey, key), sql`${datasetVersions.datasetId} <> ${datasetId}`))
          .limit(1);
        if (!other) orphaned.push(key);
      }
      const upRows = await db.select({ key: uploads.storageKey, uploadId: uploads.s3UploadId, status: uploads.status }).from(uploads).where(eq(uploads.datasetId, datasetId));
      await ctx.progress('delete-objects', 40);
      for (const u of upRows) if (u.status === 'INITIATED') await storage.abortMultipartUpload(u.key, u.uploadId);
      await storage.deleteKeys([...new Set([...orphaned, ...versions.map((v) => v.archiveKey), ...upRows.map((u) => u.key)])]);
      for (const v of versions) await storage.deletePrefix(storageKeys.analyticsPrefix(v.organizationId, v.id));
      await ctx.progress('delete-rows', 80);
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL okf.allow_purge = 'on'`);
        await tx.delete(datasets).where(eq(datasets.id, datasetId));
      });
      return { versions: versions.length, blobsDeleted: orphaned.length };
    },
  };
}

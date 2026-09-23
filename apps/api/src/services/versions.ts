import { datasets, datasetVersions, enqueueJob, eq, type Executor, refreshDatasetStatus, sql } from '@okf/db';

export interface NewVersionInput {
  datasetId: string;
  organizationId: string;
  createdBy: string | null;
  sourceType: 'upload' | 'import';
  sourceUrl: string | null;
  originalFilename: string;
  archiveKey: string;
  archiveSize: number | null;
  notes: string;
}

/**
 * Create the next version (PROCESSING) and its ingestion job in the caller's transaction.
 * The dataset row is locked so concurrent uploads get distinct, gap-free numbers.
 */
export async function createVersionWithJob(tx: Executor, input: NewVersionInput) {
  await tx.execute(sql`SELECT 1 FROM ${datasets} WHERE id = ${input.datasetId} FOR UPDATE`);
  const [{ next }] = (
    await tx.execute<{ next: number }>(sql`SELECT coalesce(max(number), 0) + 1 AS next FROM ${datasetVersions} WHERE dataset_id = ${input.datasetId}`)
  ).rows as [{ next: number }];
  const [version] = await tx
    .insert(datasetVersions)
    .values({
      datasetId: input.datasetId,
      organizationId: input.organizationId,
      number: Number(next),
      status: 'PROCESSING',
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      originalFilename: input.originalFilename,
      archiveKey: input.archiveKey,
      archiveSize: input.archiveSize,
      notes: input.notes,
      createdBy: input.createdBy,
    })
    .returning();
  const job = await enqueueJob(tx, {
    type: 'ingest_version',
    organizationId: input.organizationId,
    datasetId: input.datasetId,
    versionId: version!.id,
    createdBy: input.createdBy,
    payload: { sourceType: input.sourceType, sourceUrl: input.sourceUrl, filename: input.originalFilename },
  });
  await tx.update(datasets).set({ latestVersionId: version!.id }).where(eq(datasets.id, input.datasetId));
  await refreshDatasetStatus(tx, input.datasetId);
  return { version: version!, job };
}

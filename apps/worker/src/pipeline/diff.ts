import { type BundleProfile, diffVersions, type FieldSchemaEntry, type JsonValue, type VersionSnapshot } from '@okf/core';
import { asc, concepts, datasetVersions, eq, schemaColumns, versionDiffs } from '@okf/db';
import { JobFailure, type JobHandler, type WorkerDeps } from '../context';

async function snapshot(deps: WorkerDeps, versionId: string): Promise<VersionSnapshot & { number: number }> {
  const [v] = await deps.db.select().from(datasetVersions).where(eq(datasetVersions.id, versionId));
  if (!v || !v.profile || !v.fieldSchema) throw new JobFailure('VERSION_NOT_READY', 'Both versions must be processed before they can be compared.', 'load');
  const rows = await deps.db
    .select({ id: concepts.conceptId, type: concepts.type, title: concepts.title, sha256: concepts.sha256, frontmatter: concepts.frontmatter })
    .from(concepts)
    .where(eq(concepts.versionId, versionId));
  const cols = await deps.db.select().from(schemaColumns).where(eq(schemaColumns.versionId, versionId)).orderBy(asc(schemaColumns.ordinal));
  const colsBy = new Map<string, { name: string; dataType: string | null }[]>();
  for (const c of cols) colsBy.set(c.conceptId, [...(colsBy.get(c.conceptId) ?? []), { name: c.name, dataType: c.dataType }]);
  return {
    number: v.number,
    concepts: rows.map((r) => ({ ...r, frontmatter: r.frontmatter as Record<string, JsonValue>, schemaColumns: colsBy.get(r.id) ?? null })),
    fieldSchema: v.fieldSchema as FieldSchemaEntry[],
    profile: v.profile as BundleProfile,
  };
}

export function diffHandler(deps: WorkerDeps): JobHandler {
  return {
    async run(ctx) {
      const { baseVersionId, targetVersionId } = ctx.job.payload as { baseVersionId?: string; targetVersionId?: string };
      if (!baseVersionId || !targetVersionId || !ctx.job.datasetId) throw new JobFailure('BAD_JOB', 'Diff job is missing its versions.');
      await ctx.progress('load', 10);
      const [base, target] = await Promise.all([snapshot(deps, baseVersionId), snapshot(deps, targetVersionId)]);
      await ctx.progress('compare', 50);
      const result = diffVersions(base, target);
      await deps.db
        .insert(versionDiffs)
        .values({ datasetId: ctx.job.datasetId, baseVersionId, targetVersionId, result })
        .onConflictDoUpdate({ target: [versionDiffs.baseVersionId, versionDiffs.targetVersionId], set: { result } });
      return { base: base.number, target: target.number, summary: result.summary };
    },
  };
}

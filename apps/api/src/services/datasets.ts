import {
  and,
  datasetGrants,
  datasets,
  datasetTags,
  datasetUsageDaily,
  datasetVersions,
  desc,
  eq,
  type Executor,
  gte,
  inArray,
  jobs,
  organizationMembers,
  organizations,
  sql,
  tags,
  users,
} from '@okf/db';
import {
  canDataset,
  type DatasetDTO,
  type DatasetFacts,
  datasetAccess,
  type GrantRole,
  type JobDTO,
  type OrgRole,
  type Principal,
  slugify,
  type VersionDTO,
} from '@okf/shared';
import type { AppDeps } from '../deps';
import { notFound } from '../lib/errors';
import { iso } from '../types';
import { type DatasetAuthz, type DatasetRow, permittedActions } from './access';

export type VersionRow = typeof datasetVersions.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

export const USAGE_WINDOW_DAYS = 30;

export function jobDTO(j: JobRow): JobDTO {
  const err = j.error as { code?: string; message?: string; stage?: string | null } | null;
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    stage: j.stage,
    progress: j.progress,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    error: err ? { code: err.code ?? 'ERROR', message: err.message ?? 'Job failed', stage: err.stage ?? null } : null,
    result: j.result ?? null,
    createdAt: j.createdAt.toISOString(),
    startedAt: iso(j.startedAt),
    finishedAt: iso(j.finishedAt),
  };
}

export function versionDTO(v: VersionRow, createdBy: { id: string; name: string } | null, job: JobRow | null): VersionDTO {
  const failure = v.failure as { code: string; message: string; stage?: string | null } | null;
  return {
    id: v.id,
    number: v.number,
    status: v.status,
    notes: v.notes,
    sourceType: v.sourceType === 'import' ? 'import' : 'upload',
    sourceUrl: v.sourceUrl,
    originalFilename: v.originalFilename,
    format: v.format,
    archiveSize: v.archiveSize,
    archiveSha256: v.archiveSha256,
    scanStatus: v.scanStatus,
    okfVersion: v.okfVersion,
    conceptCount: v.conceptCount,
    fileCount: v.fileCount,
    totalBytes: v.totalBytes,
    valid: v.valid,
    errorCount: v.errorCount,
    warningCount: v.warningCount,
    infoCount: v.infoCount,
    qualityScore: v.qualityScore,
    failure: failure ? { code: failure.code, message: failure.message, stage: failure.stage ?? null } : null,
    createdBy,
    createdAt: v.createdAt.toISOString(),
    processedAt: iso(v.processedAt),
    publishedAt: iso(v.publishedAt),
    job: job ? jobDTO(job) : null,
  };
}

/** Version DTOs with creator and most recent job, batched. */
export async function versionDTOs(deps: AppDeps, rows: VersionRow[]): Promise<Map<string, VersionDTO>> {
  const out = new Map<string, VersionDTO>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
  const creators = creatorIds.length ? await deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, creatorIds)) : [];
  const jobRows = await deps.db
    .selectDistinctOn([jobs.versionId])
    .from(jobs)
    .where(and(inArray(jobs.versionId, ids), eq(jobs.type, 'ingest_version')))
    .orderBy(jobs.versionId, desc(jobs.createdAt));
  const byCreator = new Map(creators.map((c) => [c.id, c]));
  const byJob = new Map(jobRows.map((j) => [j.versionId!, j]));
  for (const r of rows) out.set(r.id, versionDTO(r, r.createdBy ? (byCreator.get(r.createdBy) ?? null) : null, byJob.get(r.id) ?? null));
  return out;
}

interface ViewerContext {
  principal: Principal;
  roles: Map<string, OrgRole>;
  grants: Map<string, GrantRole>;
}

/** Load the requester's org roles and grants once, for list endpoints. */
export async function viewerContext(deps: AppDeps, principal: Principal, apiKey: { organizationId: string; role: OrgRole } | null, sessionUserId: string | null): Promise<ViewerContext> {
  const roles = new Map<string, OrgRole>();
  const grants = new Map<string, GrantRole>();
  if (apiKey) roles.set(apiKey.organizationId, apiKey.role);
  else if (principal.kind === 'user') {
    const rows = await deps.db.select().from(organizationMembers).where(eq(organizationMembers.userId, principal.userId));
    for (const r of rows) roles.set(r.organizationId, r.role);
  }
  if (sessionUserId) {
    const rows = await deps.db.select().from(datasetGrants).where(eq(datasetGrants.userId, sessionUserId));
    for (const r of rows) grants.set(r.datasetId, r.role);
  }
  return { principal, roles, grants };
}

export function factsFor(d: DatasetRow, ctx: ViewerContext): DatasetFacts {
  return {
    datasetId: d.id,
    visibility: d.visibility,
    createdBy: d.createdBy,
    hasPublishedVersion: d.publishedVersionId !== null,
    archived: d.archivedAt !== null,
    orgRole: ctx.roles.get(d.organizationId) ?? null,
    grant: ctx.grants.get(d.id) ?? null,
  };
}

/** Build dataset DTOs for rows the viewer is already known to be allowed to read. */
export async function datasetDTOs(
  deps: AppDeps,
  rows: DatasetRow[],
  authzFor: (d: DatasetRow) => { access: DatasetDTO['access']; permissions: DatasetDTO['permissions'] },
): Promise<DatasetDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((d) => d.id);
  const orgRows = await deps.db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(inArray(organizations.id, [...new Set(rows.map((d) => d.organizationId))]));
  const ownerIds = [...new Set(rows.map((d) => d.createdBy).filter((x): x is string => !!x))];
  const owners = ownerIds.length ? await deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds)) : [];
  const versionIds = [...new Set(rows.flatMap((d) => [d.latestVersionId, d.publishedVersionId]).filter((x): x is string => !!x))];
  const versionRows = versionIds.length ? await deps.db.select().from(datasetVersions).where(inArray(datasetVersions.id, versionIds)) : [];
  const versions = await versionDTOs(deps, versionRows);
  const tagRows = await deps.db
    .select({ datasetId: datasetTags.datasetId, name: tags.name })
    .from(datasetTags)
    .innerJoin(tags, eq(tags.id, datasetTags.tagId))
    .where(inArray(datasetTags.datasetId, ids));
  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const usageRows = await deps.db
    .select({
      datasetId: datasetUsageDaily.datasetId,
      views: sql<number>`sum(${datasetUsageDaily.views})::int`,
      queries: sql<number>`sum(${datasetUsageDaily.queries})::int`,
      downloads: sql<number>`sum(${datasetUsageDaily.downloads})::int`,
      apiRequests: sql<number>`sum(${datasetUsageDaily.apiRequests})::int`,
    })
    .from(datasetUsageDaily)
    .where(and(inArray(datasetUsageDaily.datasetId, ids), gte(datasetUsageDaily.day, since)))
    .groupBy(datasetUsageDaily.datasetId);

  const orgs = new Map(orgRows.map((o) => [o.id, o]));
  const ownerMap = new Map(owners.map((o) => [o.id, o]));
  const usage = new Map(usageRows.map((u) => [u.datasetId, u]));
  const tagMap = new Map<string, string[]>();
  for (const t of tagRows) tagMap.set(t.datasetId, [...(tagMap.get(t.datasetId) ?? []), t.name].sort());

  return rows.map((d) => {
    const { access, permissions } = authzFor(d);
    const seesDrafts = permissions.includes('dataset:read_drafts');
    const u = usage.get(d.id);
    return {
      id: d.id,
      organization: orgs.get(d.organizationId) ?? { id: d.organizationId, name: '', slug: '' },
      slug: d.slug,
      name: d.name,
      description: d.description,
      license: d.license,
      // Public viewers only ever see the published state.
      status: seesDrafts ? d.status : 'PUBLISHED',
      visibility: d.visibility,
      tags: tagMap.get(d.id) ?? [],
      owner: d.createdBy ? (ownerMap.get(d.createdBy) ?? null) : null,
      latestVersion: seesDrafts && d.latestVersionId ? (versions.get(d.latestVersionId) ?? null) : null,
      publishedVersion: d.publishedVersionId ? (versions.get(d.publishedVersionId) ?? null) : null,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      archivedAt: iso(d.archivedAt),
      access,
      permissions,
      usage: { views: u?.views ?? 0, queries: u?.queries ?? 0, downloads: u?.downloads ?? 0, apiRequests: u?.apiRequests ?? 0, days: USAGE_WINDOW_DAYS },
    };
  });
}

export async function datasetDTO(deps: AppDeps, authz: DatasetAuthz): Promise<DatasetDTO> {
  const [dto] = await datasetDTOs(deps, [authz.dataset], () => ({ access: authz.access, permissions: permittedActions(authz) }));
  return dto!;
}

export function listAuthz(ctx: ViewerContext) {
  return (d: DatasetRow) => {
    const facts = factsFor(d, ctx);
    const actions = [
      'dataset:read', 'dataset:read_drafts', 'dataset:query', 'dataset:download', 'dataset:update',
      'dataset:upload', 'dataset:archive', 'dataset:publish', 'dataset:share', 'dataset:delete',
    ] as const;
    return { access: datasetAccess(ctx.principal, facts), permissions: actions.filter((a) => canDataset(ctx.principal, facts, a)) };
  };
}

/**
 * Pick the version a request refers to. Explicit numbers must be visible to the caller;
 * without one, readers get the newest successfully processed version (falling back to
 * the newest version) and public viewers get the published version.
 */
export async function resolveVersion(deps: AppDeps, authz: DatasetAuthz, number?: number): Promise<VersionRow> {
  const seesDrafts = authz.can('dataset:read_drafts');
  const d = authz.dataset;
  if (number !== undefined) {
    const [v] = await deps.db.select().from(datasetVersions).where(and(eq(datasetVersions.datasetId, d.id), eq(datasetVersions.number, number)));
    if (!v || (!seesDrafts && v.id !== d.publishedVersionId)) throw notFound('Version');
    return v;
  }
  if (!seesDrafts) {
    if (!d.publishedVersionId) throw notFound('Published version');
    const [v] = await deps.db.select().from(datasetVersions).where(eq(datasetVersions.id, d.publishedVersionId));
    return v!;
  }
  const [processed] = await deps.db
    .select()
    .from(datasetVersions)
    .where(and(eq(datasetVersions.datasetId, d.id), inArray(datasetVersions.status, ['VALIDATED', 'PUBLISHED'])))
    .orderBy(desc(datasetVersions.number))
    .limit(1);
  if (processed) return processed;
  const [latest] = await deps.db.select().from(datasetVersions).where(eq(datasetVersions.datasetId, d.id)).orderBy(desc(datasetVersions.number)).limit(1);
  if (!latest) throw notFound('Version');
  return latest;
}

/** Replace a dataset's platform tags (distinct from OKF concept `tags`). */
export async function setDatasetTags(ex: Executor, organizationId: string, datasetId: string, names: string[]): Promise<void> {
  const unique = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  await ex.delete(datasetTags).where(eq(datasetTags.datasetId, datasetId));
  if (unique.length === 0) return;
  await ex.insert(tags).values(unique.map((name) => ({ organizationId, name }))).onConflictDoNothing();
  const rows = await ex.select({ id: tags.id }).from(tags).where(and(eq(tags.organizationId, organizationId), inArray(tags.name, unique)));
  await ex.insert(datasetTags).values(rows.map((r) => ({ datasetId, tagId: r.id }))).onConflictDoNothing();
}

export async function uniqueDatasetSlug(deps: AppDeps, organizationId: string, base: string): Promise<string> {
  const taken = new Set(
    (
      await deps.db
        .select({ slug: datasets.slug })
        .from(datasets)
        .where(and(eq(datasets.organizationId, organizationId), sql`${datasets.deletedAt} IS NULL`, sql`${datasets.slug} LIKE ${`${base}%`}`))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

export { slugify };

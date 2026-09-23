import { z } from 'zod';
import { API_KEY_SCOPES, GRANT_ROLES, ORG_ROLES, VISIBILITIES } from './permissions';
import { DATASET_STATUSES, JOB_STATUSES, VERSION_STATUSES } from './schemas';

/**
 * Response schemas of the REST API. The API serializes through these (unknown fields are
 * stripped, so internal columns can never leak), OpenAPI is generated from them, and the
 * web app uses the inferred types.
 */

const DATASET_ACTIONS = [
  'dataset:read', 'dataset:read_drafts', 'dataset:query', 'dataset:download', 'dataset:update',
  'dataset:upload', 'dataset:archive', 'dataset:publish', 'dataset:share', 'dataset:delete',
] as const;
const ORG_ACTIONS = [
  'org:read', 'org:update', 'org:delete', 'members:read', 'members:manage', 'members:manage_privileged',
  'invitations:manage', 'api_keys:manage', 'audit:read', 'datasets:create',
] as const;

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), page: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }) });
export type Page<T> = { data: T[]; page: { page: number; pageSize: number; total: number } };

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

export const userRefSchema = z.object({ id: z.string(), name: z.string() }).meta({ id: 'UserRef' });
export type UserRef = z.infer<typeof userRefSchema>;

export const userSchema = userRefSchema.extend({ email: z.string(), createdAt: z.string() }).meta({ id: 'User' });
export type UserDTO = z.infer<typeof userSchema>;

export const membershipSchema = z.object({ id: z.string(), name: z.string(), slug: z.string(), role: z.enum(ORG_ROLES) });
export type MembershipDTO = z.infer<typeof membershipSchema>;

export const meSchema = z
  .object({ user: userSchema, organizations: z.array(membershipSchema), csrfToken: z.string().nullable() })
  .meta({ id: 'Me' });
export type MeDTO = z.infer<typeof meSchema>;

export const sessionSchema = z
  .object({ id: z.string(), current: z.boolean(), ip: z.string().nullable(), userAgent: z.string().nullable(), createdAt: z.string(), lastSeenAt: z.string(), expiresAt: z.string() })
  .meta({ id: 'Session' });
export type SessionDTO = z.infer<typeof sessionSchema>;

export const orgSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    role: z.enum(ORG_ROLES),
    memberCount: z.number(),
    datasetCount: z.number(),
    createdAt: z.string(),
    permissions: z.array(z.enum(ORG_ACTIONS)),
  })
  .meta({ id: 'Organization' });
export type OrgDTO = z.infer<typeof orgSchema>;

export const memberSchema = z
  .object({ userId: z.string(), email: z.string(), name: z.string(), role: z.enum(ORG_ROLES), createdAt: z.string() })
  .meta({ id: 'Member' });
export type MemberDTO = z.infer<typeof memberSchema>;

export const invitationSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    role: z.enum(ORG_ROLES),
    createdAt: z.string(),
    expiresAt: z.string(),
    invitedBy: userRefSchema.nullable(),
    /** Only returned once, at creation (also emailed). */
    acceptUrl: z.string().optional(),
  })
  .meta({ id: 'Invitation' });
export type InvitationDTO = z.infer<typeof invitationSchema>;

export const jobSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    status: z.enum(JOB_STATUSES),
    stage: z.string().nullable(),
    progress: z.number(),
    attempts: z.number(),
    maxAttempts: z.number(),
    error: z.object({ code: z.string(), message: z.string(), stage: z.string().nullable().optional() }).nullable(),
    result: z.unknown().nullable().optional(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  })
  .meta({ id: 'Job' });
export type JobDTO = z.infer<typeof jobSchema>;

export const versionSchema = z
  .object({
    id: z.string(),
    number: z.number(),
    status: z.enum(VERSION_STATUSES),
    notes: z.string(),
    sourceType: z.enum(['upload', 'import']),
    sourceUrl: z.string().nullable(),
    originalFilename: z.string(),
    format: z.string().nullable(),
    archiveSize: z.number().nullable(),
    archiveSha256: z.string().nullable(),
    scanStatus: z.enum(['pending', 'clean', 'skipped', 'infected']),
    okfVersion: z.string().nullable(),
    conceptCount: z.number().nullable(),
    fileCount: z.number().nullable(),
    totalBytes: z.number().nullable(),
    valid: z.boolean().nullable(),
    errorCount: z.number().nullable(),
    warningCount: z.number().nullable(),
    infoCount: z.number().nullable(),
    qualityScore: z.number().nullable(),
    failure: z.object({ code: z.string(), message: z.string(), stage: z.string().nullable() }).nullable(),
    createdBy: userRefSchema.nullable(),
    createdAt: z.string(),
    processedAt: z.string().nullable(),
    publishedAt: z.string().nullable(),
    job: jobSchema.nullable(),
  })
  .meta({ id: 'Version' });
export type VersionDTO = z.infer<typeof versionSchema>;

export const datasetSchema = z
  .object({
    id: z.string(),
    organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    license: z.string().nullable(),
    status: z.enum(DATASET_STATUSES),
    visibility: z.enum(VISIBILITIES),
    tags: z.array(z.string()),
    owner: userRefSchema.nullable(),
    latestVersion: versionSchema.nullable(),
    publishedVersion: versionSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    archivedAt: z.string().nullable(),
    access: z.enum(['none', 'public', 'reader', 'editor', 'manager']),
    permissions: z.array(z.enum(DATASET_ACTIONS)),
    usage: z.object({ views: z.number(), queries: z.number(), downloads: z.number(), apiRequests: z.number(), days: z.number() }),
  })
  .meta({ id: 'Dataset' });
export type DatasetDTO = z.infer<typeof datasetSchema>;

export const conceptSummarySchema = z
  .object({
    conceptId: z.string(),
    path: z.string(),
    type: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    tags: z.array(z.string()),
    status: z.string(),
    trustTier: z.string(),
    isStale: z.boolean(),
    linkCount: z.number(),
    brokenLinkCount: z.number(),
    schemaColumnCount: z.number(),
  })
  .meta({ id: 'ConceptSummary' });
export type ConceptSummaryDTO = z.infer<typeof conceptSummarySchema>;

export const assetColumnSchema = z.object({
  ordinal: z.number(),
  name: z.string(),
  dataType: z.string().nullable(),
  mode: z.string().nullable(),
  description: z.string().nullable(),
});

export const conceptDetailSchema = conceptSummarySchema
  .extend({
    resource: z.string().nullable(),
    staleAfter: z.string().nullable(),
    generatedBy: z.string().nullable(),
    lastChangedAt: z.string().nullable(),
    verifiedBy: z.array(z.string()),
    frontmatter: z.record(z.string(), z.unknown()),
    sources: z.array(z.unknown()),
    computation: z.unknown().nullable(),
    headings: z.array(z.object({ depth: z.number(), text: z.string(), line: z.number() })),
    body: z.string(),
    outbound: z.array(
      z.object({ raw: z.string(), kind: z.string(), targetConceptId: z.string().nullable(), targetPath: z.string().nullable(), broken: z.boolean(), via: z.string() }),
    ),
    inbound: z.array(z.object({ sourceConceptId: z.string(), via: z.string() })),
    schema: z.array(assetColumnSchema),
  })
  .meta({ id: 'ConceptDetail' });
export type ConceptDetailDTO = z.infer<typeof conceptDetailSchema>;

export const validationIssueSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    severity: z.enum(['error', 'warning', 'info']),
    layer: z.enum(['structural', 'quality']),
    location: z.object({ path: z.string(), line: z.number().nullable(), column: z.number().nullable() }),
    field: z.string().nullable(),
  })
  .meta({ id: 'ValidationIssue' });
export type ValidationIssueDTO = z.infer<typeof validationIssueSchema>;

export const validationReportSchema = z
  .object({
    version: z.number(),
    valid: z.boolean().nullable(),
    specVersion: z.string().nullable(),
    validatorVersion: z.string().nullable(),
    counts: z.object({ errors: z.number(), warnings: z.number(), infos: z.number() }),
    suppressed: z.record(z.string(), z.number()),
    byCode: z.array(z.object({ code: z.string(), severity: z.string(), layer: z.string(), count: z.number() })),
    failure: z.object({ code: z.string(), message: z.string(), stage: z.string().nullable() }).nullable(),
    issues: pageSchema(validationIssueSchema),
  })
  .meta({ id: 'ValidationReport' });
export type ValidationReportDTO = z.infer<typeof validationReportSchema>;

export const shareLinkSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    createdBy: userRefSchema.nullable(),
    /** Only returned once, at creation. */
    token: z.string().optional(),
  })
  .meta({ id: 'ShareLink' });
export type ShareLinkDTO = z.infer<typeof shareLinkSchema>;

export const grantSchema = z
  .object({ user: userRefSchema.extend({ email: z.string() }), role: z.enum(GRANT_ROLES), createdAt: z.string() })
  .meta({ id: 'Grant' });
export type GrantDTO = z.infer<typeof grantSchema>;

export const apiKeySchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.enum(API_KEY_SCOPES)),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    createdBy: userRefSchema.nullable(),
    /** Only returned once, at creation. */
    key: z.string().optional(),
  })
  .meta({ id: 'ApiKey' });
export type ApiKeyDTO = z.infer<typeof apiKeySchema>;

export const auditLogSchema = z
  .object({
    id: z.number(),
    action: z.string(),
    actorType: z.string(),
    actor: userRefSchema.nullable(),
    apiKeyId: z.string().nullable(),
    resourceType: z.string(),
    resourceId: z.string().nullable(),
    ip: z.string().nullable(),
    requestId: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .meta({ id: 'AuditLog' });
export type AuditLogDTO = z.infer<typeof auditLogSchema>;

export const uploadSessionSchema = z
  .object({
    uploadId: z.string(),
    partSize: z.number(),
    partCount: z.number(),
    expiresAt: z.string(),
    parts: z.array(z.object({ partNumber: z.number(), url: z.string() })),
    /** Parts already stored (for resuming). */
    completedParts: z.array(z.object({ partNumber: z.number(), etag: z.string(), size: z.number() })),
  })
  .meta({ id: 'UploadSession' });
export type UploadSessionDTO = z.infer<typeof uploadSessionSchema>;

export const searchHitSchema = z
  .object({
    kind: z.enum(['dataset', 'concept']),
    dataset: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
      visibility: z.enum(VISIBILITIES),
      status: z.enum(DATASET_STATUSES),
    }),
    concept: z.object({ conceptId: z.string(), type: z.string(), title: z.string() }).nullable(),
    snippet: z.string(),
    rank: z.number(),
    tags: z.array(z.string()),
    updatedAt: z.string(),
  })
  .meta({ id: 'SearchHit' });
export type SearchHitDTO = z.infer<typeof searchHitSchema>;

export const queryResultSchema = z
  .object({
    columns: z.array(z.object({ name: z.string(), type: z.string() })),
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number().nullable(),
    truncated: z.boolean(),
    elapsedMs: z.number(),
    engine: z.string(),
    version: z.number(),
  })
  .meta({ id: 'QueryResult' });
export type QueryResultDTO = z.infer<typeof queryResultSchema>;

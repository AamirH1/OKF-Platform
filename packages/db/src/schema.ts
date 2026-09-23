import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => ts('created_at').notNull().defaultNow();
const updated = () => ts('updated_at').notNull().defaultNow();
const big = (name: string) => bigint(name, { mode: 'number' });

export const orgRole = pgEnum('org_role', ['owner', 'admin', 'editor', 'viewer']);
export const datasetStatus = pgEnum('dataset_status', ['DRAFT', 'PROCESSING', 'VALIDATED', 'PUBLISHED', 'ARCHIVED', 'FAILED']);
export const versionStatus = pgEnum('version_status', ['PROCESSING', 'VALIDATED', 'FAILED', 'PUBLISHED']);
export const visibility = pgEnum('visibility', ['private', 'organization', 'public']);
export const jobStatus = pgEnum('job_status', ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
export const uploadStatus = pgEnum('upload_status', ['INITIATED', 'COMPLETED', 'ABORTED', 'EXPIRED']);
export const issueLayer = pgEnum('issue_layer', ['structural', 'quality']);
export const issueSeverity = pgEnum('issue_severity', ['error', 'warning', 'info']);
export const fileKind = pgEnum('file_kind', ['concept', 'index', 'log', 'other']);
export const grantRole = pgEnum('grant_role', ['viewer', 'editor']);
export const scanStatus = pgEnum('scan_status', ['pending', 'clean', 'skipped', 'infected']);

// ─── Identity ────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** Null for accounts that only sign in through an external identity provider. */
    passwordHash: text('password_hash'),
    emailVerifiedAt: ts('email_verified_at'),
    lastLoginAt: ts('last_login_at'),
    createdAt: created(),
    updatedAt: updated(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`)],
);

/** External identities (OAuth/OIDC). Present for future providers; password auth uses users.password_hash. */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerSubject: text('provider_subject').notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('auth_identities_provider_subject_uq').on(t.provider, t.providerSubject), index('auth_identities_user_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    csrfTokenHash: text('csrf_token_hash').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: created(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
  },
  (t) => [uniqueIndex('password_reset_tokens_hash_uq').on(t.tokenHash), index('password_reset_tokens_user_idx').on(t.userId)],
);

// ─── Organizations ───────────────────────────────────────────────────────────

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    updatedAt: updated(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [uniqueIndex('organizations_slug_uq').on(t.slug)],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] }), index('organization_members_user_idx').on(t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: orgRole('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    uniqueIndex('invitations_token_hash_uq').on(t.tokenHash),
    index('invitations_org_idx').on(t.organizationId),
    // At most one pending invitation per email per organization.
    uniqueIndex('invitations_pending_uq')
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.acceptedAt} IS NULL AND ${t.revokedAt} IS NULL`),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Public, non-secret identifier shown in the UI (e.g. `okf_ab12cd34`). */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: created(),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('api_keys_hash_uq').on(t.keyHash), uniqueIndex('api_keys_prefix_uq').on(t.prefix), index('api_keys_org_idx').on(t.organizationId)],
);

// ─── Datasets ────────────────────────────────────────────────────────────────

export const datasets = pgTable(
  'datasets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    license: text('license'),
    status: datasetStatus('status').notNull().default('DRAFT'),
    visibility: visibility('visibility').notNull().default('organization'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    latestVersionId: uuid('latest_version_id'),
    publishedVersionId: uuid('published_version_id'),
    /** Denormalized text from the latest version (types, tags, concept titles, column names). */
    searchText: text('search_text').notNull().default(''),
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(name, '')), 'A') || setweight(to_tsvector('simple', coalesce(search_text, '')), 'B') || setweight(to_tsvector('english', coalesce(description, '')), 'C')`,
    ),
    createdAt: created(),
    updatedAt: updated(),
    archivedAt: ts('archived_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('datasets_org_slug_uq').on(t.organizationId, t.slug).where(sql`${t.deletedAt} IS NULL`),
    index('datasets_org_idx').on(t.organizationId, t.updatedAt),
    index('datasets_search_idx').using('gin', t.search),
    index('datasets_public_idx').on(t.visibility, t.status).where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const datasetVersions = pgTable(
  'dataset_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id').notNull().references(() => datasets.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    status: versionStatus('status').notNull().default('PROCESSING'),
    notes: text('notes').notNull().default(''),
    sourceType: text('source_type').notNull(),
    sourceUrl: text('source_url'),
    originalFilename: text('original_filename').notNull(),
    archiveKey: text('archive_key').notNull(),
    archiveSize: big('archive_size'),
    archiveSha256: text('archive_sha256'),
    format: text('format'),
    scanStatus: scanStatus('scan_status').notNull().default('pending'),
    scanEngine: text('scan_engine'),
    okfVersion: text('okf_version'),
    conceptCount: integer('concept_count'),
    fileCount: integer('file_count'),
    totalBytes: big('total_bytes'),
    valid: boolean('valid'),
    errorCount: integer('error_count'),
    warningCount: integer('warning_count'),
    infoCount: integer('info_count'),
    qualityScore: integer('quality_score'),
    profile: jsonb('profile'),
    fieldSchema: jsonb('field_schema'),
    metadata: jsonb('metadata'),
    failure: jsonb('failure'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    processedAt: ts('processed_at'),
    publishedAt: ts('published_at'),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('dataset_versions_number_uq').on(t.datasetId, t.number),
    index('dataset_versions_org_idx').on(t.organizationId),
  ],
);

export const datasetFiles = pgTable(
  'dataset_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionId: uuid('version_id').notNull().references(() => datasetVersions.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    kind: fileKind('kind').notNull(),
    size: big('size').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
  },
  (t) => [uniqueIndex('dataset_files_version_path_uq').on(t.versionId, t.path), index('dataset_files_sha_idx').on(t.sha256)],
);

/** One row per OKF concept per version — the platform's "records" (ADR-0001). */
export const concepts = pgTable(
  'concepts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionId: uuid('version_id').notNull().references(() => datasetVersions.id, { onDelete: 'cascade' }),
    datasetId: uuid('dataset_id').notNull().references(() => datasets.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    conceptId: text('concept_id').notNull(),
    path: text('path').notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    titleDerived: boolean('title_derived').notNull(),
    description: text('description'),
    resource: text('resource'),
    tags: text('tags').array().notNull(),
    status: text('status').notNull(),
    trustTier: text('trust_tier').notNull(),
    isStale: boolean('is_stale').notNull(),
    staleAfter: text('stale_after'),
    generatedBy: text('generated_by'),
    lastChangedAt: text('last_changed_at'),
    verifiedBy: text('verified_by').array().notNull(),
    sourceCount: integer('source_count').notNull(),
    linkCount: integer('link_count').notNull(),
    brokenLinkCount: integer('broken_link_count').notNull(),
    wordCount: integer('word_count').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    frontmatter: jsonb('frontmatter').notNull(),
    headings: jsonb('headings').notNull(),
    sources: jsonb('sources').notNull(),
    computation: jsonb('computation'),
    excerpt: text('excerpt').notNull(),
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(type, '') || ' ' || okf_tags_text(tags)), 'B') || setweight(to_tsvector('english', coalesce(description, '')), 'C') || setweight(to_tsvector('english', coalesce(excerpt, '')), 'D')`,
    ),
  },
  (t) => [
    uniqueIndex('concepts_version_concept_uq').on(t.versionId, t.conceptId),
    index('concepts_version_type_idx').on(t.versionId, t.type),
    index('concepts_search_idx').using('gin', t.search),
    index('concepts_tags_idx').using('gin', t.tags),
  ],
);

export const conceptLinks = pgTable(
  'concept_links',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    versionId: uuid('version_id').notNull().references(() => datasetVersions.id, { onDelete: 'cascade' }),
    sourceConceptId: text('source_concept_id').notNull(),
    via: text('via').notNull(),
    kind: text('kind').notNull(),
    raw: text('raw').notNull(),
    targetPath: text('target_path'),
    targetConceptId: text('target_concept_id'),
    broken: boolean('broken').notNull(),
    line: integer('line'),
    text: text('text'),
  },
  (t) => [
    index('concept_links_source_idx').on(t.versionId, t.sourceConceptId),
    index('concept_links_target_idx').on(t.versionId, t.targetConceptId),
  ],
);

/** Asset-schema columns parsed from `# Schema` sections (producer documentation, not enforced). */
export const schemaColumns = pgTable(
  'schema_columns',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    versionId: uuid('version_id').notNull().references(() => datasetVersions.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id').notNull(),
    format: text('format').notNull(),
    ordinal: integer('ordinal').notNull(),
    name: text('name').notNull(),
    dataType: text('data_type'),
    mode: text('mode'),
    description: text('description'),
  },
  (t) => [
    index('schema_columns_version_concept_idx').on(t.versionId, t.conceptId, t.ordinal),
    index('schema_columns_name_idx').on(sql`lower(${t.name})`),
  ],
);

export const validationRuns = pgTable(
  'validation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionId: uuid('version_id').notNull().references(() => datasetVersions.id, { onDelete: 'cascade' }),
    specVersion: text('spec_version').notNull(),
    validatorVersion: text('validator_version').notNull(),
    valid: boolean('valid').notNull(),
    errorCount: integer('error_count').notNull(),
    warningCount: integer('warning_count').notNull(),
    infoCount: integer('info_count').notNull(),
    suppressed: jsonb('suppressed').notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull(),
  },
  (t) => [index('validation_runs_version_idx').on(t.versionId)],
);

export const validationIssues = pgTable(
  'validation_issues',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id').notNull().references(() => validationRuns.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').notNull().references(() => datasetVersions.id, { onDelete: 'cascade' }),
    layer: issueLayer('layer').notNull(),
    severity: issueSeverity('severity').notNull(),
    code: text('code').notNull(),
    message: text('message').notNull(),
    path: text('path').notNull(),
    line: integer('line'),
    column: integer('column'),
    field: text('field'),
  },
  (t) => [index('validation_issues_run_idx').on(t.runId, t.severity), index('validation_issues_version_code_idx').on(t.versionId, t.code)],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('tags_org_name_uq').on(t.organizationId, t.name)],
);

export const datasetTags = pgTable(
  'dataset_tags',
  {
    datasetId: uuid('dataset_id').notNull().references(() => datasets.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.datasetId, t.tagId] }), index('dataset_tags_tag_idx').on(t.tagId)],
);

/** Per-user access to a dataset, used for sharing private datasets. */
export const datasetGrants = pgTable(
  'dataset_grants',
  {
    datasetId: uuid('dataset_id').notNull().references(() => datasets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: grantRole('role').notNull(),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.datasetId, t.userId] }), index('dataset_grants_user_idx').on(t.userId)],
);

/** Unguessable read-only links to a dataset's published version. */
export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id').notNull().references(() => datasets.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    label: text('label').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [uniqueIndex('share_links_token_hash_uq').on(t.tokenHash), index('share_links_dataset_idx').on(t.datasetId)],
);

export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    datasetId: uuid('dataset_id').notNull().references(() => datasets.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    size: big('size').notNull(),
    contentType: text('content_type').notNull(),
    storageKey: text('storage_key').notNull(),
    s3UploadId: text('s3_upload_id').notNull(),
    partSize: integer('part_size').notNull(),
    partCount: integer('part_count').notNull(),
    status: uploadStatus('status').notNull().default('INITIATED'),
    notes: text('notes').notNull().default(''),
    versionId: uuid('version_id'),
    createdAt: created(),
    completedAt: ts('completed_at'),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('uploads_dataset_idx').on(t.datasetId), index('uploads_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'INITIATED'`)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    status: jobStatus('status').notNull().default('QUEUED'),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    datasetId: uuid('dataset_id').references(() => datasets.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => datasetVersions.id, { onDelete: 'cascade' }),
    payload: jsonb('payload').notNull().default({}),
    result: jsonb('result'),
    error: jsonb('error'),
    stage: text('stage'),
    progress: integer('progress').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAfter: ts('run_after').notNull().defaultNow(),
    lockedBy: text('locked_by'),
    lockedAt: ts('locked_at'),
    heartbeatAt: ts('heartbeat_at'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('jobs_claim_idx').on(t.runAfter).where(sql`${t.status} = 'QUEUED'`),
    index('jobs_running_idx').on(t.heartbeatAt).where(sql`${t.status} = 'RUNNING'`),
    index('jobs_dataset_idx').on(t.datasetId, t.createdAt),
  ],
);

export const versionDiffs = pgTable(
  'version_diffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id').notNull().references(() => datasets.id, { onDelete: 'cascade' }),
    baseVersionId: uuid('base_version_id').notNull().references(() => datasetVersions.id, { onDelete: 'cascade' }),
    targetVersionId: uuid('target_version_id').notNull().references(() => datasetVersions.id, { onDelete: 'cascade' }),
    result: jsonb('result').notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('version_diffs_pair_uq').on(t.baseVersionId, t.targetVersionId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'set null' }),
    actorType: text('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorApiKeyId: uuid('actor_api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: created(),
  },
  (t) => [
    index('audit_logs_org_time_idx').on(t.organizationId, t.createdAt.desc()),
    index('audit_logs_resource_idx').on(t.resourceType, t.resourceId),
    index('audit_logs_actor_idx').on(t.actorUserId, t.createdAt.desc()),
  ],
);

export const datasetUsageDaily = pgTable(
  'dataset_usage_daily',
  {
    datasetId: uuid('dataset_id').notNull().references(() => datasets.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    views: integer('views').notNull().default(0),
    queries: integer('queries').notNull().default(0),
    downloads: integer('downloads').notNull().default(0),
    apiRequests: integer('api_requests').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.datasetId, t.day] })],
);

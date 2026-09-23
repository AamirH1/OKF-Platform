import type { ApiKeyScope, DatasetAccess, DatasetAction, GrantRole, OrgAction, OrgRole, Visibility } from './permissions';
import type { DatasetStatus, JobStatus, VersionStatus } from './schemas';

/** Response shapes of the REST API (docs/openapi.yaml is generated from the API's schemas). */

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

export interface Page<T> {
  data: T[];
  page: { page: number; pageSize: number; total: number };
}

export interface UserRef {
  id: string;
  name: string;
}

export interface UserDTO extends UserRef {
  email: string;
  createdAt: string;
}

export interface MembershipDTO {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
}

export interface MeDTO {
  user: UserDTO;
  organizations: MembershipDTO[];
  /** Present for cookie sessions; send as `x-csrf-token` on mutating requests. */
  csrfToken: string | null;
}

export interface OrgDTO {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  memberCount: number;
  datasetCount: number;
  createdAt: string;
  permissions: OrgAction[];
}

export interface MemberDTO {
  userId: string;
  email: string;
  name: string;
  role: OrgRole;
  createdAt: string;
}

export interface InvitationDTO {
  id: string;
  email: string;
  role: OrgRole;
  createdAt: string;
  expiresAt: string;
  invitedBy: UserRef | null;
}

export interface VersionFailure {
  code: string;
  message: string;
  stage: string | null;
}

export interface VersionDTO {
  id: string;
  number: number;
  status: VersionStatus;
  notes: string;
  sourceType: 'upload' | 'import';
  sourceUrl: string | null;
  originalFilename: string;
  format: string | null;
  archiveSize: number | null;
  archiveSha256: string | null;
  scanStatus: 'pending' | 'clean' | 'skipped' | 'infected';
  okfVersion: string | null;
  conceptCount: number | null;
  fileCount: number | null;
  totalBytes: number | null;
  valid: boolean | null;
  errorCount: number | null;
  warningCount: number | null;
  infoCount: number | null;
  qualityScore: number | null;
  failure: VersionFailure | null;
  createdBy: UserRef | null;
  createdAt: string;
  processedAt: string | null;
  publishedAt: string | null;
  job: JobDTO | null;
}

export interface DatasetDTO {
  id: string;
  organization: { id: string; name: string; slug: string };
  slug: string;
  name: string;
  description: string;
  license: string | null;
  status: DatasetStatus;
  visibility: Visibility;
  tags: string[];
  owner: UserRef | null;
  latestVersion: VersionDTO | null;
  publishedVersion: VersionDTO | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  access: DatasetAccess;
  permissions: DatasetAction[];
  usage: { views: number; queries: number; downloads: number; apiRequests: number; days: number };
}

export interface JobDTO {
  id: string;
  type: string;
  status: JobStatus;
  stage: string | null;
  progress: number;
  attempts: number;
  maxAttempts: number;
  error: { code: string; message: string; stage?: string | null } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ConceptSummaryDTO {
  conceptId: string;
  path: string;
  type: string;
  title: string;
  description: string | null;
  tags: string[];
  status: string;
  trustTier: string;
  isStale: boolean;
  linkCount: number;
  brokenLinkCount: number;
  schemaColumnCount: number;
}

export interface ConceptDetailDTO extends ConceptSummaryDTO {
  resource: string | null;
  staleAfter: string | null;
  generatedBy: string | null;
  lastChangedAt: string | null;
  verifiedBy: string[];
  frontmatter: Record<string, unknown>;
  sources: unknown[];
  computation: unknown | null;
  headings: { depth: number; text: string; line: number }[];
  body: string;
  outbound: { raw: string; kind: string; targetConceptId: string | null; targetPath: string | null; broken: boolean; via: string }[];
  inbound: { sourceConceptId: string; via: string }[];
  schema: { ordinal: number; name: string; dataType: string | null; mode: string | null; description: string | null }[];
}

export interface ValidationIssueDTO {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  layer: 'structural' | 'quality';
  location: { path: string; line: number | null; column: number | null };
  field: string | null;
}

export interface ValidationReportDTO {
  valid: boolean;
  specVersion: string;
  validatorVersion: string;
  counts: { errors: number; warnings: number; infos: number };
  suppressed: Record<string, number>;
  byCode: { code: string; severity: string; layer: string; count: number }[];
  issues: Page<ValidationIssueDTO>;
}

export interface ShareLinkDTO {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdBy: UserRef | null;
  /** Only returned once, at creation. */
  url?: string;
  token?: string;
}

export interface GrantDTO {
  user: UserRef & { email: string };
  role: GrantRole;
  createdAt: string;
}

export interface ApiKeyDTO {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: UserRef | null;
  /** Only returned once, at creation. */
  key?: string;
}

export interface AuditLogDTO {
  id: number;
  action: string;
  actorType: string;
  actor: UserRef | null;
  apiKeyId: string | null;
  resourceType: string;
  resourceId: string | null;
  ip: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UploadSessionDTO {
  uploadId: string;
  partSize: number;
  partCount: number;
  expiresAt: string;
  /** Presigned PUT URLs by part number. */
  parts: { partNumber: number; url: string }[];
}

export interface SearchHitDTO {
  kind: 'dataset' | 'concept';
  dataset: { id: string; name: string; slug: string; organization: { id: string; name: string; slug: string }; visibility: Visibility; status: DatasetStatus };
  concept: { conceptId: string; type: string; title: string } | null;
  snippet: string;
  rank: number;
  tags: string[];
  updatedAt: string;
}

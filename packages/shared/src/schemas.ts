import { z } from 'zod';
import { API_KEY_SCOPES, GRANT_ROLES, ORG_ROLES, VISIBILITIES } from './permissions';

/** Request schemas shared by the API (enforcement) and the web app (form validation). */

export const emailSchema = z.email().max(254).transform((e) => e.trim().toLowerCase());
/** NIST 800-63B: length over composition rules; 12+ characters, bounded to keep hashing cheap. */
export const passwordSchema = z.string().min(12, 'Use at least 12 characters').max(256);
const name = z.string().trim().min(1).max(120);
export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single dashes');
const uuid = z.uuid();

export const signupSchema = z.object({ email: emailSchema, password: passwordSchema, name });
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(256) });
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const updateProfileSchema = z.object({ name });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema });

export const createOrgSchema = z.object({ name, slug: slugSchema.optional() });
export const updateOrgSchema = z.object({ name });
export const inviteMemberSchema = z.object({ email: emailSchema, role: z.enum(ORG_ROLES) });
export const updateMemberSchema = z.object({ role: z.enum(ORG_ROLES) });
export const acceptInvitationSchema = z.object({ token: z.string().min(20).max(200) });

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'Tags use letters, numbers, spaces, dots, dashes');

export const createDatasetSchema = z.object({
  organizationId: uuid,
  name,
  slug: slugSchema.optional(),
  description: z.string().max(5000).default(''),
  visibility: z.enum(VISIBILITIES).default('organization'),
  license: z.string().trim().max(120).nullable().optional(),
  tags: z.array(tagSchema).max(20).default([]),
});

export const updateDatasetSchema = z.object({
  name: name.optional(),
  description: z.string().max(5000).optional(),
  license: z.string().trim().max(120).nullable().optional(),
  tags: z.array(tagSchema).max(20).optional(),
});

export const visibilitySchema = z.object({ visibility: z.enum(VISIBILITIES) });

export const DATASET_STATUSES = ['DRAFT', 'PROCESSING', 'VALIDATED', 'PUBLISHED', 'ARCHIVED', 'FAILED'] as const;
export type DatasetStatus = (typeof DATASET_STATUSES)[number];
export const VERSION_STATUSES = ['PROCESSING', 'VALIDATED', 'FAILED', 'PUBLISHED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const listDatasetsQuerySchema = paginationSchema.extend({
  organizationId: uuid.optional(),
  status: z.enum(DATASET_STATUSES).optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  tag: tagSchema.optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['updated', 'created', 'name']).default('updated'),
});

export const ALLOWED_UPLOAD_EXTENSIONS = ['.zip', '.tar.gz', '.tgz', '.tar', '.md'] as const;

export const createUploadSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((f) => !f.includes('/') && !f.includes('\\') && !f.includes('\u0000'), 'Filename must not contain path separators')
    .refine((f) => ALLOWED_UPLOAD_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)), {
      message: `Upload one of: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`,
    }),
  size: z.number().int().positive(),
  contentType: z.string().max(100).default('application/octet-stream'),
  notes: z.string().max(2000).default(''),
});

export const completeUploadSchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }))
    .min(1)
    .max(10_000),
});

export const importUrlSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  filename: z.string().trim().max(255).optional(),
  notes: z.string().max(2000).default(''),
});

export const FILTER_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'starts_with', 'in', 'is_null', 'is_not_null', 'has'] as const;
export const QUERY_TABLES = ['concepts', 'links', 'schema_columns'] as const;

export const structuredQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
  table: z.enum(QUERY_TABLES).default('concepts'),
  columns: z.array(z.string().max(64)).max(50).optional(),
  filters: z
    .array(
      z.object({
        column: z.string().max(64),
        op: z.enum(FILTER_OPS),
        value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.union([z.string().max(500), z.number()])).max(100), z.null()]).optional(),
      }),
    )
    .max(20)
    .default([]),
  search: z.string().max(200).optional(),
  sort: z.array(z.object({ column: z.string().max(64), direction: z.enum(['asc', 'desc']) })).max(5).default([]),
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(500).default(50),
});

export const sqlQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
  sql: z.string().min(1).max(20_000),
  maxRows: z.number().int().min(1).max(1000).optional(),
});

export const searchQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).default(''),
  scope: z.enum(['datasets', 'concepts']).default('datasets'),
  organizationId: uuid.optional(),
  tag: tagSchema.optional(),
  type: z.string().max(120).optional(),
  status: z.enum(DATASET_STATUSES).optional(),
  sort: z.enum(['relevance', 'updated', 'name']).default('relevance'),
});

export const createShareLinkSchema = z.object({
  label: z.string().trim().max(120).default(''),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(30),
});

export const grantAccessSchema = z.object({ email: emailSchema, role: z.enum(GRANT_ROLES) });

export const createApiKeySchema = z.object({
  organizationId: uuid,
  name,
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});

export const diffRequestSchema = z.object({ base: z.number().int().min(1), target: z.number().int().min(1) });

export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s.length >= 2 ? s : `item-${s || 'x'}`;
}

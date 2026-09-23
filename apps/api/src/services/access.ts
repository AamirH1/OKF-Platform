import type { FastifyRequest } from 'fastify';
import {
  and,
  datasetGrants,
  datasets,
  eq,
  isNull,
  organizationMembers,
  shareLinks,
} from '@okf/db';
import {
  canDataset,
  canOrg,
  type DatasetAccess,
  type DatasetAction,
  type DatasetFacts,
  datasetAccess,
  type GrantRole,
  type OrgAction,
  type OrgRole,
  type Principal,
} from '@okf/shared';
import type { AppDeps } from '../deps';
import { safeEqual, sha256 } from '../lib/crypto';
import { forbidden, notFound } from '../lib/errors';

export type DatasetRow = typeof datasets.$inferSelect;

export interface DatasetAuthz {
  dataset: DatasetRow;
  facts: DatasetFacts;
  principal: Principal;
  access: DatasetAccess;
  orgRole: OrgRole | null;
  can: (action: DatasetAction) => boolean;
}

const DATASET_ACTIONS: DatasetAction[] = [
  'dataset:read', 'dataset:read_drafts', 'dataset:query', 'dataset:download', 'dataset:update',
  'dataset:upload', 'dataset:archive', 'dataset:publish', 'dataset:share', 'dataset:delete',
];

/** Principal's role in an organization. API keys only count within their own organization. */
export async function orgRoleFor(deps: AppDeps, req: FastifyRequest, organizationId: string): Promise<OrgRole | null> {
  const { auth } = req;
  if (auth.apiKey) return auth.apiKey.organizationId === organizationId ? auth.apiKey.role : null;
  if (!auth.user) return null;
  const [m] = await deps.db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, auth.user.id)));
  return m?.role ?? null;
}

/** Authorize an organization action. Non-members get 404 so organizations cannot be enumerated. */
export async function authorizeOrg(deps: AppDeps, req: FastifyRequest, organizationId: string, action: OrgAction): Promise<OrgRole> {
  const role = await orgRoleFor(deps, req, organizationId);
  if (!role) throw notFound('Organization');
  if (!canOrg(req.auth.principal, role, action)) throw forbidden();
  return role;
}

function shareTokenOf(req: FastifyRequest): string | null {
  const header = req.headers['x-share-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  const q = (req.query as Record<string, unknown> | undefined)?.shareToken;
  return typeof q === 'string' && q.length > 0 ? q : null;
}

async function validShareLink(deps: AppDeps, token: string, datasetId: string): Promise<boolean> {
  const [link] = await deps.db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.tokenHash, sha256(token)), eq(shareLinks.datasetId, datasetId), isNull(shareLinks.revokedAt)));
  if (!link || !safeEqual(link.tokenHash, sha256(token))) return false;
  if (link.expiresAt && link.expiresAt <= new Date()) return false;
  await deps.db.update(shareLinks).set({ lastUsedAt: new Date() }).where(eq(shareLinks.id, link.id));
  return true;
}

/**
 * Resolve what the requester may do with a dataset. Every dataset route calls this;
 * facts come from the database, never from the client.
 */
export async function resolveDataset(deps: AppDeps, req: FastifyRequest, datasetId: string): Promise<DatasetAuthz | null> {
  const [dataset] = await deps.db.select().from(datasets).where(and(eq(datasets.id, datasetId), isNull(datasets.deletedAt)));
  if (!dataset) return null;
  const orgRole = await orgRoleFor(deps, req, dataset.organizationId);
  let grant: GrantRole | null = null;
  if (req.auth.session && req.auth.user) {
    const [g] = await deps.db
      .select({ role: datasetGrants.role })
      .from(datasetGrants)
      .where(and(eq(datasetGrants.datasetId, datasetId), eq(datasetGrants.userId, req.auth.user.id)));
    grant = g?.role ?? null;
  }
  const facts: DatasetFacts = {
    datasetId,
    visibility: dataset.visibility,
    createdBy: dataset.createdBy,
    hasPublishedVersion: dataset.publishedVersionId !== null,
    archived: dataset.archivedAt !== null,
    orgRole,
    grant,
  };
  let principal = req.auth.principal;
  let access = datasetAccess(principal, facts);
  if (access === 'none') {
    const token = shareTokenOf(req);
    if (token && (await validShareLink(deps, token, datasetId))) {
      principal = { kind: 'share_link', datasetId };
      access = datasetAccess(principal, facts);
    }
  }
  const p = principal;
  return { dataset, facts, principal: p, access, orgRole, can: (action) => canDataset(p, facts, action) };
}

/** 404 when the dataset is invisible to the requester (no existence leak), 403 when visible but not allowed. */
export async function authorizeDataset(deps: AppDeps, req: FastifyRequest, datasetId: string, action: DatasetAction): Promise<DatasetAuthz> {
  const authz = await resolveDataset(deps, req, datasetId);
  if (!authz || authz.access === 'none' || !authz.can('dataset:read')) throw notFound('Dataset');
  if (!authz.can(action)) throw forbidden();
  return authz;
}

export function permittedActions(authz: DatasetAuthz): DatasetAction[] {
  return DATASET_ACTIONS.filter((a) => authz.can(a));
}

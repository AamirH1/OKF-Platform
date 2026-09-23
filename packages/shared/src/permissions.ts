/**
 * Authorization model. The API is the only enforcement point (it resolves the facts in
 * `DatasetFacts`/`Principal` from the database for every request); the web app imports
 * this module solely to hide controls the user cannot use.
 */

export const ORG_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_RANK: Record<OrgRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export const VISIBILITIES = ['private', 'organization', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const GRANT_ROLES = ['viewer', 'editor'] as const;
export type GrantRole = (typeof GRANT_ROLES)[number];

export const API_KEY_SCOPES = ['datasets:read', 'datasets:write', 'datasets:publish'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type OrgAction =
  | 'org:read'
  | 'org:update'
  | 'org:delete'
  | 'members:read'
  | 'members:manage'
  | 'members:manage_privileged'
  | 'invitations:manage'
  | 'api_keys:manage'
  | 'audit:read'
  | 'datasets:create';

export type DatasetAction =
  | 'dataset:read'
  | 'dataset:read_drafts'
  | 'dataset:query'
  | 'dataset:download'
  | 'dataset:update'
  | 'dataset:upload'
  | 'dataset:archive'
  | 'dataset:publish'
  | 'dataset:share'
  | 'dataset:delete';

export type Principal =
  | { kind: 'anonymous' }
  | { kind: 'user'; userId: string }
  | { kind: 'api_key'; userId: string; keyId: string; organizationId: string; scopes: ApiKeyScope[] }
  | { kind: 'share_link'; datasetId: string };

const ORG_ACTIONS: Record<OrgRole, OrgAction[]> = {
  viewer: ['org:read', 'members:read'],
  editor: ['org:read', 'members:read', 'datasets:create'],
  admin: ['org:read', 'members:read', 'datasets:create', 'org:update', 'members:manage', 'invitations:manage', 'api_keys:manage', 'audit:read'],
  owner: [
    'org:read', 'members:read', 'datasets:create', 'org:update', 'members:manage', 'invitations:manage', 'api_keys:manage', 'audit:read',
    'org:delete', 'members:manage_privileged',
  ],
};

/** Actions an API key may ever perform, per scope. Account/admin actions need a browser session. */
const SCOPE_ACTIONS: Record<ApiKeyScope, (OrgAction | DatasetAction)[]> = {
  'datasets:read': ['org:read', 'dataset:read', 'dataset:read_drafts', 'dataset:query', 'dataset:download'],
  'datasets:write': ['datasets:create', 'dataset:update', 'dataset:upload', 'dataset:archive'],
  'datasets:publish': ['dataset:publish'],
};

export function scopeAllows(scopes: readonly ApiKeyScope[], action: OrgAction | DatasetAction): boolean {
  return scopes.some((s) => SCOPE_ACTIONS[s]?.includes(action));
}

/** Org role of the principal in the organization, resolved by the API; null when not a member. */
export function canOrg(principal: Principal, role: OrgRole | null, action: OrgAction): boolean {
  if (principal.kind === 'anonymous' || principal.kind === 'share_link' || !role) return false;
  if (!ORG_ACTIONS[role].includes(action)) return false;
  if (principal.kind === 'api_key') return scopeAllows(principal.scopes, action);
  return true;
}

export interface DatasetFacts {
  datasetId: string;
  visibility: Visibility;
  createdBy: string | null;
  hasPublishedVersion: boolean;
  archived: boolean;
  /** Principal's role in the dataset's organization, or null. */
  orgRole: OrgRole | null;
  /** Principal's per-dataset grant, or null. */
  grant: GrantRole | null;
}

/**
 * Access level on one dataset:
 * - `public`  — may see only the published version (anonymous/public, share links)
 * - `reader`  — all versions, including drafts
 * - `editor`  — plus edit metadata and upload versions
 * - `manager` — plus publish, share, archive and delete
 */
export type DatasetAccess = 'none' | 'public' | 'reader' | 'editor' | 'manager';

const ACCESS_RANK: Record<DatasetAccess, number> = { none: 0, public: 1, reader: 2, editor: 3, manager: 4 };

const ACCESS_ACTIONS: Record<Exclude<DatasetAccess, 'none'>, DatasetAction[]> = {
  public: ['dataset:read', 'dataset:query', 'dataset:download'],
  reader: ['dataset:read', 'dataset:query', 'dataset:download', 'dataset:read_drafts'],
  editor: ['dataset:read', 'dataset:query', 'dataset:download', 'dataset:read_drafts', 'dataset:update', 'dataset:upload'],
  manager: [
    'dataset:read', 'dataset:query', 'dataset:download', 'dataset:read_drafts', 'dataset:update', 'dataset:upload',
    'dataset:archive', 'dataset:publish', 'dataset:share', 'dataset:delete',
  ],
};

const max = (a: DatasetAccess, b: DatasetAccess): DatasetAccess => (ACCESS_RANK[a] >= ACCESS_RANK[b] ? a : b);

export function datasetAccess(principal: Principal, f: DatasetFacts): DatasetAccess {
  const publicRead: DatasetAccess = f.visibility === 'public' && f.hasPublishedVersion ? 'public' : 'none';
  if (principal.kind === 'anonymous') return publicRead;
  if (principal.kind === 'share_link') {
    return principal.datasetId === f.datasetId && f.hasPublishedVersion ? 'public' : 'none';
  }

  let access: DatasetAccess = publicRead;
  const role = f.orgRole;
  if (role === 'owner' || role === 'admin') access = 'manager';
  else if (role === 'editor') {
    if (f.visibility !== 'private' || f.createdBy === principal.userId) access = max(access, 'editor');
  } else if (role === 'viewer') {
    if (f.visibility !== 'private') access = max(access, 'reader');
  }
  // The creator of a private dataset manages it (unless they left the organization).
  if (role && f.visibility === 'private' && f.createdBy === principal.userId) access = max(access, 'manager');
  if (f.grant === 'editor') access = max(access, 'editor');
  if (f.grant === 'viewer') access = max(access, 'reader');
  return access;
}

export function canDataset(principal: Principal, f: DatasetFacts, action: DatasetAction): boolean {
  const access = datasetAccess(principal, f);
  if (access === 'none') return false;
  if (!ACCESS_ACTIONS[access].includes(action)) return false;
  // Archived datasets are read-only until unarchived by a manager.
  if (f.archived && (action === 'dataset:update' || action === 'dataset:upload' || action === 'dataset:publish')) return false;
  if (principal.kind === 'api_key') return scopeAllows(principal.scopes, action);
  return true;
}

/** Whether `actorRole` may assign `targetRole` to someone currently holding `currentRole`. */
export function canAssignRole(actorRole: OrgRole, currentRole: OrgRole | null, targetRole: OrgRole): boolean {
  const privileged = (r: OrgRole | null) => r === 'owner' || r === 'admin';
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return !privileged(currentRole) && !privileged(targetRole);
  return false;
}

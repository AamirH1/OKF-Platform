import { describe, expect, it } from 'vitest';
import {
  canAssignRole,
  canDataset,
  canOrg,
  type DatasetAction,
  type DatasetFacts,
  datasetAccess,
  type OrgRole,
  type Principal,
  slugify,
} from '../src';

const user: Principal = { kind: 'user', userId: 'u1' };
const facts = (over: Partial<DatasetFacts> = {}): DatasetFacts => ({
  datasetId: 'd1',
  visibility: 'organization',
  createdBy: 'someone-else',
  hasPublishedVersion: true,
  archived: false,
  orgRole: null,
  grant: null,
  ...over,
});

describe('datasetAccess matrix', () => {
  const roles: (OrgRole | null)[] = ['owner', 'admin', 'editor', 'viewer', null];
  const table: Record<string, Record<string, string>> = {
    private: { owner: 'manager', admin: 'manager', editor: 'none', viewer: 'none', null: 'none' },
    organization: { owner: 'manager', admin: 'manager', editor: 'editor', viewer: 'reader', null: 'none' },
    public: { owner: 'manager', admin: 'manager', editor: 'editor', viewer: 'reader', null: 'public' },
  };
  for (const [visibility, expected] of Object.entries(table)) {
    for (const role of roles) {
      it(`${visibility} × ${role ?? 'non-member'} → ${expected[String(role)]}`, () => {
        expect(datasetAccess(user, facts({ visibility: visibility as never, orgRole: role }))).toBe(expected[String(role)]);
      });
    }
  }

  it('public datasets are invisible until a version is published', () => {
    expect(datasetAccess({ kind: 'anonymous' }, facts({ visibility: 'public', hasPublishedVersion: false }))).toBe('none');
    expect(datasetAccess({ kind: 'anonymous' }, facts({ visibility: 'public' }))).toBe('public');
    expect(datasetAccess({ kind: 'anonymous' }, facts({ visibility: 'organization' }))).toBe('none');
  });

  it('share links grant published-only read on their own dataset', () => {
    expect(datasetAccess({ kind: 'share_link', datasetId: 'd1' }, facts({ visibility: 'private' }))).toBe('public');
    expect(datasetAccess({ kind: 'share_link', datasetId: 'other' }, facts({ visibility: 'private' }))).toBe('none');
    expect(datasetAccess({ kind: 'share_link', datasetId: 'd1' }, facts({ hasPublishedVersion: false }))).toBe('none');
  });

  it('grants and private-dataset creators', () => {
    expect(datasetAccess(user, facts({ visibility: 'private', grant: 'viewer' }))).toBe('reader');
    expect(datasetAccess(user, facts({ visibility: 'private', grant: 'editor', orgRole: 'viewer' }))).toBe('editor');
    expect(datasetAccess(user, facts({ visibility: 'private', createdBy: 'u1', orgRole: 'editor' }))).toBe('manager');
    // A creator who left the organization loses access.
    expect(datasetAccess(user, facts({ visibility: 'private', createdBy: 'u1', orgRole: null }))).toBe('none');
  });
});

describe('canDataset', () => {
  it('only managers publish, share and delete', () => {
    const actions: DatasetAction[] = ['dataset:publish', 'dataset:share', 'dataset:delete'];
    for (const a of actions) {
      expect(canDataset(user, facts({ orgRole: 'admin' }), a)).toBe(true);
      expect(canDataset(user, facts({ orgRole: 'editor' }), a)).toBe(false);
    }
    expect(canDataset(user, facts({ orgRole: 'editor' }), 'dataset:upload')).toBe(true);
    expect(canDataset(user, facts({ orgRole: 'viewer' }), 'dataset:upload')).toBe(false);
    expect(canDataset(user, facts({ orgRole: 'viewer' }), 'dataset:read_drafts')).toBe(true);
    expect(canDataset({ kind: 'anonymous' }, facts({ visibility: 'public' }), 'dataset:read_drafts')).toBe(false);
  });

  it('archived datasets are read-only', () => {
    expect(canDataset(user, facts({ orgRole: 'owner', archived: true }), 'dataset:upload')).toBe(false);
    expect(canDataset(user, facts({ orgRole: 'owner', archived: true }), 'dataset:archive')).toBe(true);
  });

  it('API keys are capped by scopes', () => {
    const key: Principal = { kind: 'api_key', userId: 'u1', keyId: 'k', organizationId: 'o', scopes: ['datasets:read'] };
    expect(canDataset(key, facts({ orgRole: 'owner' }), 'dataset:query')).toBe(true);
    expect(canDataset(key, facts({ orgRole: 'owner' }), 'dataset:upload')).toBe(false);
    const writer: Principal = { ...key, scopes: ['datasets:read', 'datasets:write', 'datasets:publish'] };
    expect(canDataset(writer, facts({ orgRole: 'owner' }), 'dataset:publish')).toBe(true);
    // Destructive/sharing actions are session-only even for full-scope keys.
    expect(canDataset(writer, facts({ orgRole: 'owner' }), 'dataset:delete')).toBe(false);
    expect(canDataset(writer, facts({ orgRole: 'owner' }), 'dataset:share')).toBe(false);
    // Scopes never exceed the creator's role.
    expect(canDataset(writer, facts({ orgRole: 'viewer' }), 'dataset:upload')).toBe(false);
  });
});

describe('org permissions', () => {
  it('role ladder', () => {
    expect(canOrg(user, 'viewer', 'datasets:create')).toBe(false);
    expect(canOrg(user, 'editor', 'datasets:create')).toBe(true);
    expect(canOrg(user, 'editor', 'members:manage')).toBe(false);
    expect(canOrg(user, 'admin', 'audit:read')).toBe(true);
    expect(canOrg(user, 'admin', 'org:delete')).toBe(false);
    expect(canOrg(user, 'owner', 'org:delete')).toBe(true);
    expect(canOrg(user, null, 'org:read')).toBe(false);
    const key: Principal = { kind: 'api_key', userId: 'u1', keyId: 'k', organizationId: 'o', scopes: ['datasets:read', 'datasets:write', 'datasets:publish'] };
    expect(canOrg(key, 'owner', 'api_keys:manage')).toBe(false);
    expect(canOrg(key, 'owner', 'datasets:create')).toBe(true);
  });

  it('role assignment rules', () => {
    expect(canAssignRole('owner', 'viewer', 'owner')).toBe(true);
    expect(canAssignRole('admin', 'viewer', 'editor')).toBe(true);
    expect(canAssignRole('admin', 'viewer', 'admin')).toBe(false);
    expect(canAssignRole('admin', 'admin', 'viewer')).toBe(false);
    expect(canAssignRole('editor', 'viewer', 'editor')).toBe(false);
  });
});

it('slugify', () => {
  expect(slugify('Café Métricas — Q3 2026!')).toBe('cafe-metricas-q3-2026');
  expect(slugify('!!')).toBe('item-x');
});

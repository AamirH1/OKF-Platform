import type { FastifyRequest } from 'fastify';
import { auditLogs, type Executor } from '@okf/db';

/**
 * Audit actions. Dotted `resource.verb` names; the list is the contract for the audit UI
 * and for anyone querying `audit_logs` directly.
 */
export type AuditAction =
  | 'auth.signup'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.password_reset_requested'
  | 'auth.password_reset'
  | 'auth.password_changed'
  | 'auth.session_revoked'
  | 'user.profile_updated'
  | 'org.created'
  | 'org.updated'
  | 'org.deleted'
  | 'member.role_changed'
  | 'member.removed'
  | 'member.joined'
  | 'invitation.created'
  | 'invitation.revoked'
  | 'dataset.created'
  | 'dataset.updated'
  | 'dataset.deleted'
  | 'dataset.published'
  | 'dataset.unpublished'
  | 'dataset.archived'
  | 'dataset.unarchived'
  | 'dataset.visibility_changed'
  | 'dataset.downloaded'
  | 'upload.created'
  | 'upload.aborted'
  | 'version.created'
  | 'version.validated'
  | 'version.failed'
  | 'query.sql'
  | 'grant.created'
  | 'grant.revoked'
  | 'share_link.created'
  | 'share_link.revoked'
  | 'api_key.created'
  | 'api_key.revoked'
  | 'job.cancel_requested';

export interface AuditEntry {
  action: AuditAction;
  organizationId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  /** Override the actor (e.g. a failed login has no authenticated user yet). */
  actorUserId?: string | null;
}

export async function audit(ex: Executor, req: FastifyRequest, entry: AuditEntry): Promise<void> {
  const a = req.auth;
  await ex.insert(auditLogs).values({
    organizationId: entry.organizationId ?? null,
    actorType: a.apiKey ? 'api_key' : a.user ? 'user' : entry.actorUserId ? 'user' : 'anonymous',
    actorUserId: entry.actorUserId !== undefined ? entry.actorUserId : (a.user?.id ?? null),
    actorApiKeyId: a.apiKey?.id ?? null,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
    requestId: req.id,
    metadata: entry.metadata ?? {},
  });
}

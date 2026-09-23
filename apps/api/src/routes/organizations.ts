import { z } from 'zod';
import {
  and,
  asc,
  count,
  datasets,
  enqueueJob,
  eq,
  gt,
  invitations,
  isNull,
  organizationMembers,
  organizations,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
  sql,
  users,
} from '@okf/db';
import {
  acceptInvitationSchema,
  canAssignRole,
  canOrg,
  createOrgSchema,
  invitationSchema,
  inviteMemberSchema,
  memberSchema,
  meSchema,
  type OrgAction,
  orgSchema,
  type OrgRole,
  slugify,
  updateMemberSchema,
  updateOrgSchema,
} from '@okf/shared';
import type { AppDeps } from '../deps';
import { audit } from '../lib/audit';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { CSRF_COOKIE, requireSession, requireUser } from '../plugins/auth';
import { authorizeOrg } from '../services/access';
import { buildMe } from '../services/users';
import { errorResponses, type RoutePlugin, uuidParam } from '../types';

const INVITE_TTL_MS = 7 * 24 * 3_600_000;
const ORG_ACTIONS: OrgAction[] = [
  'org:read', 'org:update', 'org:delete', 'members:read', 'members:manage', 'members:manage_privileged',
  'invitations:manage', 'api_keys:manage', 'audit:read', 'datasets:create',
];

async function orgDTO(deps: AppDeps, orgId: string, role: OrgRole, principal: Parameters<typeof canOrg>[0]) {
  const [org] = await deps.db.select().from(organizations).where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)));
  if (!org) throw notFound('Organization');
  const [{ members }] = (await deps.db.select({ members: count() }).from(organizationMembers).where(eq(organizationMembers.organizationId, orgId))) as [{ members: number }];
  const [{ n }] = (await deps.db.select({ n: count() }).from(datasets).where(and(eq(datasets.organizationId, orgId), isNull(datasets.deletedAt)))) as [{ n: number }];
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    role,
    memberCount: Number(members),
    datasetCount: Number(n),
    createdAt: org.createdAt.toISOString(),
    permissions: ORG_ACTIONS.filter((a) => canOrg(principal, role, a)),
  };
}

async function uniqueOrgSlug(deps: AppDeps, base: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const [hit] = await deps.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
    if (!hit) return slug;
  }
  return `${base}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });

const routes: RoutePlugin = async (app, { deps }) => {
  app.get('/organizations', { schema: { tags: ['organizations'], summary: 'Organizations the caller belongs to', response: { 200: z.object({ data: z.array(orgSchema) }), ...errorResponses } } }, async (req) => {
    const user = requireUser(req);
    const rows = await deps.db
      .select({ id: organizations.id, role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(organizations, and(eq(organizations.id, organizationMembers.organizationId), isNull(organizations.deletedAt)))
      .where(and(eq(organizationMembers.userId, user.id), req.auth.apiKey ? eq(organizations.id, req.auth.apiKey.organizationId) : sql`TRUE`))
      .orderBy(asc(organizations.name));
    const effectiveRole = (r: OrgRole) => (req.auth.apiKey ? req.auth.apiKey.role : r);
    return { data: await Promise.all(rows.map((r) => orgDTO(deps, r.id, effectiveRole(r.role), req.auth.principal))) };
  });

  app.post(
    '/organizations',
    { schema: { tags: ['organizations'], summary: 'Create an organization (caller becomes owner)', body: createOrgSchema, response: { 201: orgSchema, ...errorResponses } } },
    async (req, reply) => {
      const user = requireSession(req);
      const slug = req.body.slug ?? (await uniqueOrgSlug(deps, slugify(req.body.name)));
      let orgId: string;
      try {
        orgId = await deps.db.transaction(async (tx) => {
          const [org] = await tx.insert(organizations).values({ name: req.body.name, slug, createdBy: user.id }).returning();
          await tx.insert(organizationMembers).values({ organizationId: org!.id, userId: user.id, role: 'owner' });
          await audit(tx, req, { action: 'org.created', organizationId: org!.id, resourceType: 'organization', resourceId: org!.id, metadata: { name: org!.name, slug } });
          return org!.id;
        });
      } catch (e) {
        if (pgErrorCode(e) === PG_UNIQUE_VIOLATION) throw conflict(`The slug "${slug}" is already taken.`, 'SLUG_TAKEN');
        throw e;
      }
      return reply.code(201).send(await orgDTO(deps, orgId, 'owner', req.auth.principal));
    },
  );

  app.get('/organizations/:id', { schema: { tags: ['organizations'], params: uuidParam, response: { 200: orgSchema, ...errorResponses } } }, async (req) => {
    const role = await authorizeOrg(deps, req, req.params.id, 'org:read');
    return orgDTO(deps, req.params.id, role, req.auth.principal);
  });

  app.patch('/organizations/:id', { schema: { tags: ['organizations'], params: uuidParam, body: updateOrgSchema, response: { 200: orgSchema, ...errorResponses } } }, async (req) => {
    requireSession(req);
    const role = await authorizeOrg(deps, req, req.params.id, 'org:update');
    await deps.db.update(organizations).set({ name: req.body.name, updatedAt: new Date() }).where(eq(organizations.id, req.params.id));
    await audit(deps.db, req, { action: 'org.updated', organizationId: req.params.id, resourceType: 'organization', resourceId: req.params.id, metadata: { name: req.body.name } });
    return orgDTO(deps, req.params.id, role, req.auth.principal);
  });

  app.delete(
    '/organizations/:id',
    { schema: { tags: ['organizations'], summary: 'Soft-delete an organization and its datasets', params: uuidParam, response: { 204: z.null(), ...errorResponses } } },
    async (req, reply) => {
      requireSession(req);
      await authorizeOrg(deps, req, req.params.id, 'org:delete');
      await deps.db.transaction(async (tx) => {
        const now = new Date();
        await tx.update(organizations).set({ deletedAt: now, slug: sql`${organizations.slug} || '-deleted-' || extract(epoch from now())::bigint` }).where(eq(organizations.id, req.params.id));
        const removed = await tx
          .update(datasets)
          .set({ deletedAt: now, publishedVersionId: null })
          .where(and(eq(datasets.organizationId, req.params.id), isNull(datasets.deletedAt)))
          .returning({ id: datasets.id });
        // Stored files and version data are removed asynchronously, one job per dataset.
        for (const d of removed) {
          await enqueueJob(tx, { type: 'purge_dataset', organizationId: req.params.id, datasetId: d.id, createdBy: req.auth.user?.id ?? null });
        }
        await audit(tx, req, { action: 'org.deleted', organizationId: req.params.id, resourceType: 'organization', resourceId: req.params.id });
      });
      return reply.code(204).send(null);
    },
  );

  // ─── Members ──────────────────────────────────────────────────────────────

  app.get('/organizations/:id/members', { schema: { tags: ['members'], params: uuidParam, response: { 200: z.object({ data: z.array(memberSchema) }), ...errorResponses } } }, async (req) => {
    await authorizeOrg(deps, req, req.params.id, 'members:read');
    const rows = await deps.db
      .select({ userId: users.id, email: users.email, name: users.name, role: organizationMembers.role, createdAt: organizationMembers.createdAt })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, req.params.id))
      .orderBy(asc(users.name));
    return { data: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  });

  const ownerCount = async (orgId: string) => {
    const [{ n }] = (await deps.db
      .select({ n: count() })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, 'owner')))) as [{ n: number }];
    return Number(n);
  };

  app.patch(
    '/organizations/:id/members/:userId',
    { schema: { tags: ['members'], summary: 'Change a member role', params: memberParams, body: updateMemberSchema, response: { 200: memberSchema, ...errorResponses } } },
    async (req) => {
      requireSession(req);
      const actorRole = await authorizeOrg(deps, req, req.params.id, 'members:manage');
      const [target] = await deps.db
        .select()
        .from(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, req.params.id), eq(organizationMembers.userId, req.params.userId)));
      if (!target) throw notFound('Member');
      if (!canAssignRole(actorRole, target.role, req.body.role)) throw forbidden('Only owners can grant or change owner and admin roles.');
      if (target.role === 'owner' && req.body.role !== 'owner' && (await ownerCount(req.params.id)) <= 1) {
        throw new AppError(409, 'LAST_OWNER', 'An organization must keep at least one owner.');
      }
      await deps.db
        .update(organizationMembers)
        .set({ role: req.body.role, updatedAt: new Date() })
        .where(and(eq(organizationMembers.organizationId, req.params.id), eq(organizationMembers.userId, req.params.userId)));
      await audit(deps.db, req, {
        action: 'member.role_changed',
        organizationId: req.params.id,
        resourceType: 'user',
        resourceId: req.params.userId,
        metadata: { from: target.role, to: req.body.role },
      });
      const [u] = await deps.db.select().from(users).where(eq(users.id, req.params.userId));
      return { userId: u!.id, email: u!.email, name: u!.name, role: req.body.role, createdAt: target.createdAt.toISOString() };
    },
  );

  app.delete(
    '/organizations/:id/members/:userId',
    { schema: { tags: ['members'], summary: 'Remove a member (or leave, when removing yourself)', params: memberParams, response: { 204: z.null(), ...errorResponses } } },
    async (req, reply) => {
      const user = requireSession(req);
      const self = user.id === req.params.userId;
      const actorRole = await authorizeOrg(deps, req, req.params.id, self ? 'org:read' : 'members:manage');
      const [target] = await deps.db
        .select()
        .from(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, req.params.id), eq(organizationMembers.userId, req.params.userId)));
      if (!target) throw notFound('Member');
      if (!self && !canAssignRole(actorRole, target.role, 'viewer')) throw forbidden('Only owners can remove owners and admins.');
      if (target.role === 'owner' && (await ownerCount(req.params.id)) <= 1) {
        throw new AppError(409, 'LAST_OWNER', 'An organization must keep at least one owner.');
      }
      await deps.db
        .delete(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, req.params.id), eq(organizationMembers.userId, req.params.userId)));
      await audit(deps.db, req, { action: 'member.removed', organizationId: req.params.id, resourceType: 'user', resourceId: req.params.userId, metadata: { role: target.role, self } });
      return reply.code(204).send(null);
    },
  );

  // ─── Invitations ──────────────────────────────────────────────────────────

  app.get('/organizations/:id/invitations', { schema: { tags: ['members'], params: uuidParam, response: { 200: z.object({ data: z.array(invitationSchema) }), ...errorResponses } } }, async (req) => {
    await authorizeOrg(deps, req, req.params.id, 'invitations:manage');
    const rows = await deps.db
      .select({ inv: invitations, by: { id: users.id, name: users.name } })
      .from(invitations)
      .leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.organizationId, req.params.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, sql`now()`)))
      .orderBy(asc(invitations.createdAt));
    return {
      data: rows.map((r) => ({
        id: r.inv.id,
        email: r.inv.email,
        role: r.inv.role,
        createdAt: r.inv.createdAt.toISOString(),
        expiresAt: r.inv.expiresAt.toISOString(),
        invitedBy: r.by?.id ? { id: r.by.id, name: r.by.name } : null,
      })),
    };
  });

  app.post(
    '/organizations/:id/invitations',
    { schema: { tags: ['members'], summary: 'Invite someone by email', params: uuidParam, body: inviteMemberSchema, response: { 201: invitationSchema, ...errorResponses } } },
    async (req, reply) => {
      const user = requireSession(req);
      const actorRole = await authorizeOrg(deps, req, req.params.id, 'invitations:manage');
      if (!canAssignRole(actorRole, null, req.body.role)) throw forbidden('Only owners can invite owners and admins.');
      const [already] = await deps.db
        .select({ id: users.id })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.organizationId, req.params.id), sql`lower(${users.email}) = ${req.body.email}`));
      if (already) throw conflict('That person is already a member.', 'ALREADY_MEMBER');
      const token = randomToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      let inv;
      try {
        [inv] = await deps.db
          .insert(invitations)
          .values({ organizationId: req.params.id, email: req.body.email, role: req.body.role, tokenHash: sha256(token), invitedBy: user.id, expiresAt })
          .returning();
      } catch (e) {
        if (pgErrorCode(e) === PG_UNIQUE_VIOLATION) throw conflict('There is already a pending invitation for this email.', 'INVITATION_PENDING');
        throw e;
      }
      const [org] = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, req.params.id));
      const acceptUrl = `${deps.env.WEB_ORIGIN}/invitations/accept?token=${encodeURIComponent(token)}`;
      try {
        await deps.mailer.send({
          to: req.body.email,
          subject: `You're invited to ${org?.name ?? 'an organization'} on OKF Platform`,
          text: `${user.name} invited you to join ${org?.name} as ${req.body.role}.\n\nAccept within 7 days: ${acceptUrl}`,
        });
      } catch (err) {
        req.log.error({ err }, 'invitation email failed');
      }
      await audit(deps.db, req, { action: 'invitation.created', organizationId: req.params.id, resourceType: 'invitation', resourceId: inv!.id, metadata: { email: req.body.email, role: req.body.role } });
      return reply.code(201).send({
        id: inv!.id,
        email: inv!.email,
        role: inv!.role,
        createdAt: inv!.createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        invitedBy: { id: user.id, name: user.name },
        acceptUrl,
      });
    },
  );

  app.delete(
    '/organizations/:id/invitations/:invitationId',
    { schema: { tags: ['members'], params: z.object({ id: z.uuid(), invitationId: z.uuid() }), response: { 204: z.null(), ...errorResponses } } },
    async (req, reply) => {
      requireSession(req);
      await authorizeOrg(deps, req, req.params.id, 'invitations:manage');
      const [row] = await deps.db
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(and(eq(invitations.id, req.params.invitationId), eq(invitations.organizationId, req.params.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
        .returning({ id: invitations.id });
      if (!row) throw notFound('Invitation');
      await audit(deps.db, req, { action: 'invitation.revoked', organizationId: req.params.id, resourceType: 'invitation', resourceId: row.id });
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/invitations/accept',
    {
      schema: {
        tags: ['members'],
        summary: 'Accept an invitation',
        description: 'The signed-in user must use the invited email address.',
        body: acceptInvitationSchema,
        response: { 200: meSchema, ...errorResponses },
      },
    },
    async (req) => {
      const user = requireSession(req);
      const orgId = await deps.db.transaction(async (tx) => {
        const [inv] = await tx
          .select()
          .from(invitations)
          .where(and(eq(invitations.tokenHash, sha256(req.body.token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, sql`now()`)))
          .for('update');
        if (!inv) throw new AppError(400, 'INVALID_TOKEN', 'This invitation is invalid, expired or already used.');
        if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
          throw new AppError(403, 'EMAIL_MISMATCH', `This invitation was sent to ${inv.email}. Sign in with that account to accept it.`);
        }
        await tx.insert(organizationMembers).values({ organizationId: inv.organizationId, userId: user.id, role: inv.role }).onConflictDoNothing();
        await tx.update(invitations).set({ acceptedAt: new Date(), acceptedBy: user.id }).where(eq(invitations.id, inv.id));
        await audit(tx, req, { action: 'member.joined', organizationId: inv.organizationId, resourceType: 'user', resourceId: user.id, metadata: { role: inv.role, invitationId: inv.id } });
        return inv.organizationId;
      });
      req.log.info({ orgId }, 'invitation accepted');
      return buildMe(deps, user.id, req.cookies[CSRF_COOKIE] ?? null);
    },
  );
};

export default routes;

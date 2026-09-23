import { z } from 'zod';
import { and, asc, datasetGrants, desc, eq, isNull, shareLinks, sql, users } from '@okf/db';
import { createShareLinkSchema, datasetSchema, grantAccessSchema, grantSchema, shareLinkSchema } from '@okf/shared';
import { audit } from '../lib/audit';
import { randomToken, sha256 } from '../lib/crypto';
import { AppError, notFound } from '../lib/errors';
import { requireSession } from '../plugins/auth';
import { authorizeDataset } from '../services/access';
import { datasetDTO } from '../services/datasets';
import { errorResponses, iso, type RoutePlugin, uuidParam } from '../types';

const routes: RoutePlugin = async (app, { deps }) => {
  // ─── Per-user grants (share a private dataset with specific people) ─────────

  app.get('/datasets/:id/grants', { schema: { tags: ['sharing'], params: uuidParam, response: { 200: z.object({ data: z.array(grantSchema) }), ...errorResponses } } }, async (req) => {
    const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:share');
    const rows = await deps.db
      .select({ g: datasetGrants, u: { id: users.id, name: users.name, email: users.email } })
      .from(datasetGrants)
      .innerJoin(users, eq(users.id, datasetGrants.userId))
      .where(eq(datasetGrants.datasetId, authz.dataset.id))
      .orderBy(asc(users.name));
    return { data: rows.map((r) => ({ user: r.u, role: r.g.role, createdAt: r.g.createdAt.toISOString() })) };
  });

  app.post(
    '/datasets/:id/grants',
    { schema: { tags: ['sharing'], summary: 'Grant a user viewer/editor access to this dataset', params: uuidParam, body: grantAccessSchema, response: { 201: grantSchema, ...errorResponses } } },
    async (req, reply) => {
      requireSession(req);
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:share');
      const [u] = await deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(sql`lower(${users.email}) = ${req.body.email}`, isNull(users.deletedAt)));
      if (!u) throw new AppError(404, 'USER_NOT_FOUND', 'No account uses that email. Ask them to sign up first, or invite them to the organization.');
      const [g] = await deps.db
        .insert(datasetGrants)
        .values({ datasetId: authz.dataset.id, userId: u.id, role: req.body.role, grantedBy: req.auth.user!.id })
        .onConflictDoUpdate({ target: [datasetGrants.datasetId, datasetGrants.userId], set: { role: req.body.role } })
        .returning();
      await audit(deps.db, req, { action: 'grant.created', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id, metadata: { userId: u.id, role: req.body.role } });
      return reply.code(201).send({ user: u, role: g!.role, createdAt: g!.createdAt.toISOString() });
    },
  );

  app.delete(
    '/datasets/:id/grants/:userId',
    { schema: { tags: ['sharing'], params: z.object({ id: z.uuid(), userId: z.uuid() }), response: { 204: z.null(), ...errorResponses } } },
    async (req, reply) => {
      requireSession(req);
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:share');
      const rows = await deps.db.delete(datasetGrants).where(and(eq(datasetGrants.datasetId, authz.dataset.id), eq(datasetGrants.userId, req.params.userId))).returning();
      if (rows.length === 0) throw notFound('Grant');
      await audit(deps.db, req, { action: 'grant.revoked', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id, metadata: { userId: req.params.userId } });
      return reply.code(204).send(null);
    },
  );

  // ─── Share links (anyone with the link can read the published version) ─────

  app.get('/datasets/:id/share-links', { schema: { tags: ['sharing'], params: uuidParam, response: { 200: z.object({ data: z.array(shareLinkSchema) }), ...errorResponses } } }, async (req) => {
    const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:share');
    const rows = await deps.db
      .select({ l: shareLinks, by: { id: users.id, name: users.name } })
      .from(shareLinks)
      .leftJoin(users, eq(users.id, shareLinks.createdBy))
      .where(eq(shareLinks.datasetId, authz.dataset.id))
      .orderBy(desc(shareLinks.createdAt));
    return {
      data: rows.map(({ l, by }) => ({
        id: l.id,
        label: l.label,
        createdAt: l.createdAt.toISOString(),
        expiresAt: iso(l.expiresAt),
        revokedAt: iso(l.revokedAt),
        lastUsedAt: iso(l.lastUsedAt),
        createdBy: by?.id ? { id: by.id, name: by.name ?? '' } : null,
      })),
    };
  });

  app.post(
    '/datasets/:id/share-links',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Create a read-only share link to the published version',
        description: 'The token is returned once. Link holders can read and query the published version only, never drafts.',
        params: uuidParam,
        body: createShareLinkSchema,
        response: { 201: shareLinkSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const user = requireSession(req);
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:share');
      const token = randomToken();
      const expiresAt = req.body.expiresInDays ? new Date(Date.now() + req.body.expiresInDays * 86_400_000) : null;
      const [l] = await deps.db.insert(shareLinks).values({ datasetId: authz.dataset.id, tokenHash: sha256(token), label: req.body.label, createdBy: user.id, expiresAt }).returning();
      await audit(deps.db, req, { action: 'share_link.created', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id, metadata: { shareLinkId: l!.id, expiresAt: iso(expiresAt) } });
      return reply.code(201).send({
        id: l!.id,
        label: l!.label,
        createdAt: l!.createdAt.toISOString(),
        expiresAt: iso(expiresAt),
        revokedAt: null,
        lastUsedAt: null,
        createdBy: { id: user.id, name: user.name },
        token,
      });
    },
  );

  app.delete(
    '/datasets/:id/share-links/:linkId',
    { schema: { tags: ['sharing'], params: z.object({ id: z.uuid(), linkId: z.uuid() }), response: { 204: z.null(), ...errorResponses } } },
    async (req, reply) => {
      requireSession(req);
      const authz = await authorizeDataset(deps, req, req.params.id, 'dataset:share');
      const rows = await deps.db
        .update(shareLinks)
        .set({ revokedAt: new Date() })
        .where(and(eq(shareLinks.id, req.params.linkId), eq(shareLinks.datasetId, authz.dataset.id), isNull(shareLinks.revokedAt)))
        .returning();
      if (rows.length === 0) throw notFound('Share link');
      await audit(deps.db, req, { action: 'share_link.revoked', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: authz.dataset.id, metadata: { shareLinkId: req.params.linkId } });
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/shared/:token',
    {
      schema: {
        tags: ['sharing'],
        summary: 'Resolve a share link to its dataset',
        description: 'Subsequent read requests for the dataset should send the token in the `x-share-token` header.',
        security: [],
        params: z.object({ token: z.string().min(20).max(200) }),
        response: { 200: datasetSchema, ...errorResponses },
      },
    },
    async (req) => {
      const [link] = await deps.db.select({ datasetId: shareLinks.datasetId }).from(shareLinks).where(eq(shareLinks.tokenHash, sha256(req.params.token)));
      if (!link) throw notFound('Share link');
      req.headers['x-share-token'] = req.params.token;
      const authz = await authorizeDataset(deps, req, link.datasetId, 'dataset:read');
      return datasetDTO(deps, authz);
    },
  );
};

export default routes;

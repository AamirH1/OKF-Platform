import { z } from 'zod';
import { and, apiKeys, desc, eq, users } from '@okf/db';
import { apiKeySchema, canOrg, createApiKeySchema, type ApiKeyScope } from '@okf/shared';
import { audit } from '../lib/audit';
import { generateApiKey, sha256 } from '../lib/crypto';
import { notFound } from '../lib/errors';
import { requireSession } from '../plugins/auth';
import { authorizeOrg } from '../services/access';
import { errorResponses, iso, type RoutePlugin, uuidParam } from '../types';

type KeyRow = typeof apiKeys.$inferSelect;
const toDTO = (k: KeyRow, by: { id: string | null; name: string | null } | null) => ({
  id: k.id,
  organizationId: k.organizationId,
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes as ApiKeyScope[],
  createdAt: k.createdAt.toISOString(),
  expiresAt: iso(k.expiresAt),
  lastUsedAt: iso(k.lastUsedAt),
  revokedAt: iso(k.revokedAt),
  createdBy: by?.id ? { id: by.id, name: by.name ?? '' } : null,
});

/**
 * Any member may hold API keys for themselves; a key acts with its creator's current role,
 * further limited by its scopes. Admins can see and revoke every key in the organization.
 * Key management requires a browser session (a key cannot mint keys).
 */
const routes: RoutePlugin = async (app, { deps }) => {
  app.get(
    '/api-keys',
    { schema: { tags: ['api-keys'], querystring: z.object({ organizationId: z.uuid() }), response: { 200: z.object({ data: z.array(apiKeySchema) }), ...errorResponses } } },
    async (req) => {
      const user = requireSession(req);
      const role = await authorizeOrg(deps, req, req.query.organizationId, 'org:read');
      const all = canOrg(req.auth.principal, role, 'api_keys:manage');
      const rows = await deps.db
        .select({ key: apiKeys, by: { id: users.id, name: users.name } })
        .from(apiKeys)
        .leftJoin(users, eq(users.id, apiKeys.createdBy))
        .where(and(eq(apiKeys.organizationId, req.query.organizationId), all ? undefined : eq(apiKeys.createdBy, user.id)))
        .orderBy(desc(apiKeys.createdAt));
      return { data: rows.map((r) => toDTO(r.key, r.by)) };
    },
  );

  app.post(
    '/api-keys',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'Create an API key',
        description: 'The full key is returned only in this response. Only its SHA-256 hash is stored.',
        body: createApiKeySchema,
        response: { 201: apiKeySchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const user = requireSession(req);
      await authorizeOrg(deps, req, req.body.organizationId, 'org:read');
      const { key, prefix } = generateApiKey();
      const expiresAt = req.body.expiresInDays ? new Date(Date.now() + req.body.expiresInDays * 86_400_000) : null;
      const [row] = await deps.db
        .insert(apiKeys)
        .values({ organizationId: req.body.organizationId, createdBy: user.id, name: req.body.name, prefix, keyHash: sha256(key), scopes: [...new Set(req.body.scopes)], expiresAt })
        .returning();
      await audit(deps.db, req, {
        action: 'api_key.created',
        organizationId: req.body.organizationId,
        resourceType: 'api_key',
        resourceId: row!.id,
        metadata: { name: row!.name, prefix, scopes: row!.scopes, expiresAt: iso(expiresAt) },
      });
      return reply.code(201).send({ ...toDTO(row!, { id: user.id, name: user.name }), key });
    },
  );

  app.delete('/api-keys/:id', { schema: { tags: ['api-keys'], summary: 'Revoke an API key', params: uuidParam, response: { 204: z.null(), ...errorResponses } } }, async (req, reply) => {
    const user = requireSession(req);
    const [k] = await deps.db.select().from(apiKeys).where(eq(apiKeys.id, req.params.id));
    if (!k) throw notFound('API key');
    const role = await authorizeOrg(deps, req, k.organizationId, 'org:read');
    if (k.createdBy !== user.id && !canOrg(req.auth.principal, role, 'api_keys:manage')) throw notFound('API key');
    if (!k.revokedAt) {
      await deps.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, k.id));
      await audit(deps.db, req, { action: 'api_key.revoked', organizationId: k.organizationId, resourceType: 'api_key', resourceId: k.id, metadata: { prefix: k.prefix } });
    }
    return reply.code(204).send(null);
  });
};

export default routes;

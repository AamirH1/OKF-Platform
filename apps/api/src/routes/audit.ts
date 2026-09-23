import { z } from 'zod';
import { and, auditLogs, count, desc, eq, gte, lte, type SQL, users } from '@okf/db';
import { auditLogSchema, pageSchema, paginationSchema } from '@okf/shared';
import type { AppDeps } from '../deps';
import { authorizeDataset, authorizeOrg } from '../services/access';
import { errorResponses, type RoutePlugin, uuidParam } from '../types';

const filterSchema = paginationSchema.extend({
  action: z.string().max(64).optional(),
  resourceType: z.string().max(64).optional(),
  resourceId: z.string().max(128).optional(),
  actorUserId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export async function listAudit(deps: AppDeps, where: SQL[], page: number, pageSize: number) {
  const cond = and(...where);
  const rows = await deps.db
    .select({ log: auditLogs, actor: { id: users.id, name: users.name } })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(cond)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [{ n }] = (await deps.db.select({ n: count() }).from(auditLogs).where(cond)) as [{ n: number }];
  return {
    data: rows.map(({ log, actor }) => ({
      id: log.id,
      action: log.action,
      actorType: log.actorType,
      actor: actor?.id ? { id: actor.id, name: actor.name ?? '' } : null,
      apiKeyId: log.actorApiKeyId,
      resourceType: log.resourceType,
      resourceId: log.resourceId,
      ip: log.ip,
      requestId: log.requestId,
      metadata: log.metadata as Record<string, unknown>,
      createdAt: log.createdAt.toISOString(),
    })),
    page: { page, pageSize, total: Number(n) },
  };
}

const routes: RoutePlugin = async (app, { deps }) => {
  app.get(
    '/organizations/:id/audit-logs',
    { schema: { tags: ['audit'], summary: 'Organization audit log (admins)', params: uuidParam, querystring: filterSchema, response: { 200: pageSchema(auditLogSchema), ...errorResponses } } },
    async (req) => {
      await authorizeOrg(deps, req, req.params.id, 'audit:read');
      const q = req.query;
      const where: SQL[] = [eq(auditLogs.organizationId, req.params.id)];
      if (q.action) where.push(eq(auditLogs.action, q.action));
      if (q.resourceType) where.push(eq(auditLogs.resourceType, q.resourceType));
      if (q.resourceId) where.push(eq(auditLogs.resourceId, q.resourceId));
      if (q.actorUserId) where.push(eq(auditLogs.actorUserId, q.actorUserId));
      if (q.from) where.push(gte(auditLogs.createdAt, new Date(q.from)));
      if (q.to) where.push(lte(auditLogs.createdAt, new Date(q.to)));
      return listAudit(deps, where, q.page, q.pageSize);
    },
  );

  app.get(
    '/datasets/:id/activity',
    { schema: { tags: ['datasets'], summary: 'Activity (audit events) for one dataset', params: uuidParam, querystring: paginationSchema, response: { 200: pageSchema(auditLogSchema), ...errorResponses } } },
    async (req) => {
      await authorizeDataset(deps, req, req.params.id, 'dataset:read_drafts');
      return listAudit(deps, [eq(auditLogs.resourceType, 'dataset'), eq(auditLogs.resourceId, req.params.id)], req.query.page, req.query.pageSize);
    },
  );
};

export default routes;

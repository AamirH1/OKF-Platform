import { z } from 'zod';
import { and, eq, isNull, ne, sessions, users } from '@okf/db';
import { changePasswordSchema, meSchema, updateProfileSchema } from '@okf/shared';
import { audit } from '../lib/audit';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { CSRF_COOKIE, requireSession, requireUser } from '../plugins/auth';
import { buildMe } from '../services/users';
import { errorResponses, type RoutePlugin } from '../types';

const routes: RoutePlugin = async (app, { deps }) => {
  app.get('/users/me', { schema: { tags: ['users'], summary: 'Current user and organizations', response: { 200: meSchema, ...errorResponses } } }, async (req) => {
    const user = requireUser(req);
    return buildMe(deps, user.id, req.auth.session ? (req.cookies[CSRF_COOKIE] ?? null) : null);
  });

  app.patch(
    '/users/me',
    { schema: { tags: ['users'], summary: 'Update profile', body: updateProfileSchema, response: { 200: meSchema, ...errorResponses } } },
    async (req) => {
      const user = requireSession(req);
      await deps.db.update(users).set({ name: req.body.name, updatedAt: new Date() }).where(eq(users.id, user.id));
      await audit(deps.db, req, { action: 'user.profile_updated', resourceType: 'user', resourceId: user.id });
      return buildMe(deps, user.id, req.cookies[CSRF_COOKIE] ?? null);
    },
  );

  app.post(
    '/users/me/password',
    { schema: { tags: ['users'], summary: 'Change password (signs out other sessions)', body: changePasswordSchema, response: { 204: z.null(), ...errorResponses } } },
    async (req, reply) => {
      const user = requireSession(req);
      const [row] = await deps.db.select().from(users).where(and(eq(users.id, user.id), isNull(users.deletedAt)));
      if (!row?.passwordHash || !(await verifyPassword(row.passwordHash, req.body.currentPassword))) {
        throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect.');
      }
      const passwordHash = await hashPassword(req.body.newPassword);
      await deps.db.transaction(async (tx) => {
        await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, user.id));
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, user.id), ne(sessions.id, req.auth.session!.id), isNull(sessions.revokedAt)));
        await audit(tx, req, { action: 'auth.password_changed', resourceType: 'user', resourceId: user.id });
      });
      return reply.code(204).send(null);
    },
  );
};

export default routes;

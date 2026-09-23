import { z } from 'zod';
import { and, desc, eq, gt, isNull, passwordResetTokens, sessions, sql, users } from '@okf/db';
import {
  forgotPasswordSchema,
  loginSchema,
  meSchema,
  resetPasswordSchema,
  sessionSchema,
  signupSchema,
} from '@okf/shared';
import { audit } from '../lib/audit';
import { burnPasswordCheck, hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { AppError, conflict, notFound, unauthorized } from '../lib/errors';
import { clearSessionCookie, createSession, requireSession, setSessionCookie } from '../plugins/auth';
import { buildMe } from '../services/users';
import { errorResponses, iso, type RoutePlugin, uuidParam } from '../types';

const RESET_TTL_MS = 60 * 60 * 1000;

const routes: RoutePlugin = async (app, { deps }) => {
  const authLimit = { rateLimit: { max: deps.env.AUTH_RATE_LIMIT_MAX, timeWindow: deps.env.RATE_LIMIT_WINDOW_MS, keyGenerator: (req: { ip: string }) => `auth:${req.ip}` } };

  app.post(
    '/auth/signup',
    { config: authLimit, schema: { tags: ['auth'], summary: 'Create an account and start a session', security: [], body: signupSchema, response: { 201: meSchema, ...errorResponses } } },
    async (req, reply) => {
      const { email, password, name } = req.body;
      const [existing] = await deps.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
      if (existing) throw conflict('An account with this email already exists.', 'EMAIL_TAKEN');
      const passwordHash = await hashPassword(password);
      const [user] = await deps.db.insert(users).values({ email, name, passwordHash, lastLoginAt: new Date() }).returning();
      const session = await createSession(deps, user!.id, req);
      await audit(deps.db, req, { action: 'auth.signup', resourceType: 'user', resourceId: user!.id, actorUserId: user!.id });
      setSessionCookie(deps, reply, session);
      return reply.code(201).send(await buildMe(deps, user!.id, session.csrfToken));
    },
  );

  app.post(
    '/auth/login',
    { config: authLimit, schema: { tags: ['auth'], summary: 'Sign in with email and password', security: [], body: loginSchema, response: { 200: meSchema, ...errorResponses } } },
    async (req, reply) => {
      const { email, password } = req.body;
      const [user] = await deps.db.select().from(users).where(and(sql`lower(${users.email}) = ${email}`, isNull(users.deletedAt)));
      const ok = user?.passwordHash ? await verifyPassword(user.passwordHash, password) : (await burnPasswordCheck(password), false);
      if (!user || !ok) {
        await audit(deps.db, req, { action: 'auth.login_failed', resourceType: 'user', resourceId: user?.id ?? null, actorUserId: user?.id ?? null, metadata: { email } });
        throw unauthorized('Invalid email or password.');
      }
      const session = await createSession(deps, user.id, req);
      await deps.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await audit(deps.db, req, { action: 'auth.login', resourceType: 'user', resourceId: user.id, actorUserId: user.id });
      setSessionCookie(deps, reply, session);
      return buildMe(deps, user.id, session.csrfToken);
    },
  );

  app.post('/auth/logout', { schema: { tags: ['auth'], summary: 'End the current session', response: { 204: z.null(), ...errorResponses } } }, async (req, reply) => {
    if (req.auth.session) {
      await deps.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, req.auth.session.id));
      await audit(deps.db, req, { action: 'auth.logout', resourceType: 'session', resourceId: req.auth.session.id });
    }
    clearSessionCookie(deps, reply);
    return reply.code(204).send(null);
  });

  app.post(
    '/auth/forgot-password',
    {
      config: authLimit,
      schema: {
        tags: ['auth'],
        summary: 'Email a password reset link',
        description: 'Always returns 202 so the response does not reveal whether an account exists.',
        security: [],
        body: forgotPasswordSchema,
        response: { 202: z.object({ status: z.literal('accepted') }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const [user] = await deps.db.select().from(users).where(and(sql`lower(${users.email}) = ${req.body.email}`, isNull(users.deletedAt)));
      if (user) {
        const token = randomToken();
        await deps.db.insert(passwordResetTokens).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
        const link = `${deps.env.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;
        try {
          await deps.mailer.send({
            to: user.email,
            subject: 'Reset your OKF Platform password',
            text: `Someone requested a password reset for your account.\n\nReset it within one hour: ${link}\n\nIf this was not you, ignore this email.`,
          });
        } catch (err) {
          req.log.error({ err }, 'password reset email failed');
        }
        await audit(deps.db, req, { action: 'auth.password_reset_requested', resourceType: 'user', resourceId: user.id, actorUserId: user.id });
      }
      return reply.code(202).send({ status: 'accepted' as const });
    },
  );

  app.post(
    '/auth/reset-password',
    { config: authLimit, schema: { tags: ['auth'], summary: 'Set a new password with a reset token', security: [], body: resetPasswordSchema, response: { 204: z.null(), ...errorResponses } } },
    async (req, reply) => {
      const tokenHash = sha256(req.body.token);
      const passwordHash = await hashPassword(req.body.password);
      const userId = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .update(passwordResetTokens)
          .set({ usedAt: new Date() })
          .where(and(eq(passwordResetTokens.tokenHash, tokenHash), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, sql`now()`)))
          .returning({ userId: passwordResetTokens.userId });
        if (!row) throw new AppError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired.');
        await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, row.userId));
        // A reset signs out every existing session.
        await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, row.userId), isNull(sessions.revokedAt)));
        return row.userId;
      });
      await audit(deps.db, req, { action: 'auth.password_reset', resourceType: 'user', resourceId: userId, actorUserId: userId });
      clearSessionCookie(deps, reply);
      return reply.code(204).send(null);
    },
  );

  app.get('/auth/sessions', { schema: { tags: ['auth'], summary: 'List active sessions', response: { 200: z.object({ data: z.array(sessionSchema) }), ...errorResponses } } }, async (req) => {
    const user = requireSession(req);
    const rows = await deps.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)))
      .orderBy(desc(sessions.lastSeenAt));
    return {
      data: rows.map((s) => ({
        id: s.id,
        current: s.id === req.auth.session?.id,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: iso(s.createdAt)!,
        lastSeenAt: iso(s.lastSeenAt)!,
        expiresAt: iso(s.expiresAt)!,
      })),
    };
  });

  app.delete('/auth/sessions/:id', { schema: { tags: ['auth'], summary: 'Revoke a session', params: uuidParam, response: { 204: z.null(), ...errorResponses } } }, async (req, reply) => {
    const user = requireSession(req);
    const [row] = await deps.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, req.params.id), eq(sessions.userId, user.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (!row) throw notFound('Session');
    await audit(deps.db, req, { action: 'auth.session_revoked', resourceType: 'session', resourceId: row.id });
    if (row.id === req.auth.session?.id) clearSessionCookie(deps, reply);
    return reply.code(204).send(null);
  });
};

export default routes;

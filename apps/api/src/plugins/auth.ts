import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { cookieSecure } from '@okf/config';
import { and, apiKeys, eq, gt, isNull, organizationMembers, sessions, sql, users } from '@okf/db';
import type { ApiKeyScope, OrgRole, Principal } from '@okf/shared';
import { parseApiKey, randomToken, safeEqual, sha256 } from '../lib/crypto';
import { AppError, unauthorized } from '../lib/errors';
import type { AppDeps } from '../deps';

export const SESSION_COOKIE = 'okf_session';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LAST_USED_THROTTLE_MS = 60_000;

export interface AuthContext {
  principal: Principal;
  user: { id: string; email: string; name: string } | null;
  session: { id: string } | null;
  apiKey: { id: string; organizationId: string; scopes: ApiKeyScope[]; role: OrgRole } | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

const ANONYMOUS: AuthContext = { principal: { kind: 'anonymous' }, user: null, session: null, apiKey: null };

async function authenticateApiKey(deps: AppDeps, raw: string): Promise<AuthContext> {
  const parsed = parseApiKey(raw);
  if (!parsed) throw unauthorized('Invalid API key.');
  const [row] = await deps.db
    .select({ key: apiKeys, user: { id: users.id, email: users.email, name: users.name }, role: organizationMembers.role })
    .from(apiKeys)
    .innerJoin(users, and(eq(users.id, apiKeys.createdBy), isNull(users.deletedAt)))
    // The key acts with its creator's *current* role; removal from the org disables the key.
    .innerJoin(organizationMembers, and(eq(organizationMembers.organizationId, apiKeys.organizationId), eq(organizationMembers.userId, apiKeys.createdBy)))
    .where(eq(apiKeys.prefix, parsed.prefix));
  const now = new Date();
  if (!row || !safeEqual(row.key.keyHash, sha256(raw)) || row.key.revokedAt || (row.key.expiresAt && row.key.expiresAt <= now)) {
    throw unauthorized('Invalid, revoked or expired API key.');
  }
  if (!row.key.lastUsedAt || now.getTime() - row.key.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    await deps.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.key.id));
  }
  const scopes = row.key.scopes as ApiKeyScope[];
  return {
    principal: { kind: 'api_key', userId: row.user.id, keyId: row.key.id, organizationId: row.key.organizationId, scopes },
    user: row.user,
    session: null,
    apiKey: { id: row.key.id, organizationId: row.key.organizationId, scopes, role: row.role },
  };
}

async function authenticateSession(deps: AppDeps, token: string, req: FastifyRequest): Promise<AuthContext | null> {
  const [row] = await deps.db
    .select({ session: sessions, user: { id: users.id, email: users.email, name: users.name } })
    .from(sessions)
    .innerJoin(users, and(eq(users.id, sessions.userId), isNull(users.deletedAt)))
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)));
  if (!row) return null;

  if (UNSAFE.has(req.method)) {
    const header = req.headers['x-csrf-token'];
    if (typeof header !== 'string' || !safeEqual(sha256(header), row.session.csrfTokenHash)) {
      throw new AppError(403, 'CSRF_FAILED', 'Missing or invalid CSRF token. Reload the page and try again.');
    }
  }
  if (Date.now() - row.session.lastSeenAt.getTime() > LAST_USED_THROTTLE_MS) {
    await deps.db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.session.id));
  }
  return { principal: { kind: 'user', userId: row.user.id }, user: row.user, session: { id: row.session.id }, apiKey: null };
}

export default fp(async function authPlugin(app: FastifyInstance, { deps }: { deps: AppDeps }) {
  app.decorateRequest('auth', null as unknown as AuthContext);

  app.addHook('onRequest', async (req) => {
    req.auth = ANONYMOUS;
    // Browsers always send Origin on cross-site unsafe requests; refuse foreign origins
    // (defence in depth on top of SameSite cookies and CSRF tokens; also blocks login CSRF).
    const origin = req.headers.origin;
    if (UNSAFE.has(req.method) && origin && origin !== deps.env.WEB_ORIGIN) {
      throw new AppError(403, 'ORIGIN_REJECTED', 'Cross-origin request rejected.');
    }
    const authz = req.headers.authorization;
    if (authz) {
      const m = /^Bearer\s+(\S+)$/i.exec(authz);
      if (!m) throw unauthorized('Malformed Authorization header; use "Bearer <api key>".');
      req.auth = await authenticateApiKey(deps, m[1]!);
      return;
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const ctx = await authenticateSession(deps, token, req);
      if (ctx) req.auth = ctx;
    }
  });
});

export interface NewSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(deps: AppDeps, userId: string, req: FastifyRequest): Promise<NewSession> {
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + deps.env.SESSION_TTL_HOURS * 3_600_000);
  await deps.db.insert(sessions).values({
    userId,
    tokenHash: sha256(token),
    csrfTokenHash: sha256(csrfToken),
    ip: req.ip,
    userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
    expiresAt,
  });
  return { token, csrfToken, expiresAt };
}

/** Readable by the web app's JS (same site only) so it can echo it in `x-csrf-token`. */
export const CSRF_COOKIE = 'okf_csrf';

export function setSessionCookie(deps: AppDeps, reply: FastifyReply, session: NewSession): void {
  const secure = cookieSecure(deps.env);
  void reply.setCookie(SESSION_COOKIE, session.token, { httpOnly: true, secure, sameSite: 'lax', path: '/', expires: session.expiresAt });
  void reply.setCookie(CSRF_COOKIE, session.csrfToken, { httpOnly: false, secure, sameSite: 'strict', path: '/', expires: session.expiresAt });
}

export function clearSessionCookie(deps: AppDeps, reply: FastifyReply): void {
  const secure = cookieSecure(deps.env);
  void reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure, sameSite: 'lax' });
  void reply.clearCookie(CSRF_COOKIE, { path: '/', httpOnly: false, secure, sameSite: 'strict' });
}

/** Require any authenticated principal (session or API key). */
export function requireUser(req: FastifyRequest): { id: string; email: string; name: string } {
  if (!req.auth.user) throw unauthorized();
  return req.auth.user;
}

/** Require a browser session: account and administrative actions are never available to API keys. */
export function requireSession(req: FastifyRequest): { id: string; email: string; name: string } {
  const user = requireUser(req);
  if (!req.auth.session) throw new AppError(403, 'SESSION_REQUIRED', 'This action requires signing in; API keys cannot perform it.');
  return user;
}

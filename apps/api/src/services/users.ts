import { and, asc, eq, isNull, organizationMembers, organizations, users } from '@okf/db';
import type { MeDTO } from '@okf/shared';
import type { AppDeps } from '../deps';
import { notFound } from '../lib/errors';

export async function buildMe(deps: AppDeps, userId: string, csrfToken: string | null): Promise<MeDTO> {
  const [user] = await deps.db.select().from(users).where(and(eq(users.id, userId), isNull(users.deletedAt)));
  if (!user) throw notFound('User');
  const orgs = await deps.db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, and(eq(organizations.id, organizationMembers.organizationId), isNull(organizations.deletedAt)))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizations.name));
  return {
    user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt.toISOString() },
    organizations: orgs,
    csrfToken,
  };
}

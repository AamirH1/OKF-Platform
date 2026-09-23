'use client';

import type { OrgDTO } from '@okf/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/common';
import { OrgMembers } from '@/components/org';
import { api } from '@/lib/api';
import { useCurrentOrg, useRequireAuth } from '@/lib/session';

export default function MembersSettingsPage() {
  useRequireAuth();
  const { org } = useCurrentOrg();
  const q = useQuery({ queryKey: ['organization', org?.id], queryFn: () => api<OrgDTO>(`/organizations/${org!.id}`), enabled: !!org });
  if (!org) return <EmptyState title="No organization selected" action={<Link href="/organizations" className="text-primary">Organizations</Link>} />;
  return (
    <>
      <PageHeader title="Members" description={`People in ${org.name} and their roles.`} />
      {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} /> : <OrgMembers org={q.data!} />}
    </>
  );
}

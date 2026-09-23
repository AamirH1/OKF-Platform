'use client';

import type { AuditLogDTO, Page } from '@okf/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { AuditTable } from '@/components/audit';
import { EmptyState, ErrorState, LoadingRows, PageHeader, Pagination } from '@/components/common';
import { Card, CardContent, Input, Select } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useCurrentOrg, useRequireAuth } from '@/lib/session';

const RESOURCE_TYPES = ['dataset', 'organization', 'user', 'invitation', 'api_key', 'session'];

export default function AuditLogPage() {
  useRequireAuth();
  const { org } = useCurrentOrg();
  const [action, setAction] = React.useState('');
  const [resourceType, setResourceType] = React.useState('');
  const [page, setPage] = React.useState(1);
  const query = { action: action.trim(), resourceType, page, pageSize: 50 };
  const q = useQuery({
    queryKey: ['audit', org?.id, query],
    queryFn: () => api<Page<AuditLogDTO>>(`/organizations/${org!.id}/audit-logs`, { query }),
    enabled: !!org,
    placeholderData: keepPreviousData,
  });
  if (!org) return <EmptyState title="No organization selected" />;
  return (
    <>
      <PageHeader title="Audit log" description={`Security-relevant events in ${org.name}. Visible to owners and admins.`} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input placeholder="Action, e.g. dataset.published" value={action} onChange={(e) => (setAction(e.target.value), setPage(1))} aria-label="Action" className="w-64" />
        <Select value={resourceType} onChange={(e) => (setResourceType(e.target.value), setPage(1))} aria-label="Resource type" className="w-44">
          <option value="">All resources</option>
          {RESOURCE_TYPES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
      </div>
      <Card>
        <CardContent className="pt-5">
          {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} /> : (
            <>
              <AuditTable entries={q.data!.data} />
              <Pagination page={page} pageSize={50} total={q.data!.page.total} onPage={setPage} />
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}

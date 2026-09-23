'use client';

import type { DatasetDTO, OrgDTO, Page } from '@okf/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { DatasetList } from '@/components/datasets';
import { EmptyState, ErrorState, LoadingRows, PageHeader, Stat } from '@/components/common';
import { OrgMembers } from '@/components/org';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Input } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/session';

export default function OrganizationPage() {
  useRequireAuth();
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const router = useRouter();
  const org = useQuery({ queryKey: ['organization', id], queryFn: () => api<OrgDTO>(`/organizations/${id}`) });
  const datasets = useQuery({ queryKey: ['datasets', { organizationId: id }], queryFn: () => api<Page<DatasetDTO>>('/datasets', { query: { organizationId: id, pageSize: 10 } }) });
  const [name, setName] = React.useState('');
  React.useEffect(() => setName(org.data?.name ?? ''), [org.data?.name]);
  const rename = useMutation({
    mutationFn: () => api<OrgDTO>(`/organizations/${id}`, { method: 'PATCH', body: { name } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['organization', id] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Organization renamed');
    },
  });
  const del = useMutation({
    mutationFn: () => api(`/organizations/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace('/organizations');
    },
  });

  if (org.isLoading) return <LoadingRows />;
  if (org.error) return <ErrorState error={org.error} />;
  const o = org.data!;
  return (
    <>
      <PageHeader title={o.name} eyebrow="Organization" description={`Slug: ${o.slug} · Your role: ${o.role}`} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Datasets" value={o.datasetCount} />
        <Stat label="Members" value={o.memberCount} />
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Datasets</CardTitle>
          </CardHeader>
          <CardContent>
            {datasets.data && datasets.data.data.length > 0 ? <DatasetList datasets={datasets.data.data} /> : <EmptyState title="No datasets in this organization" />}
          </CardContent>
        </Card>
        <OrgMembers org={o} />
        {o.permissions.includes('org:update') ? (
          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input aria-label="Organization name" value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm" />
                <Button variant="outline" disabled={!name.trim() || name === o.name || rename.isPending} onClick={() => rename.mutate()}>
                  Rename
                </Button>
              </div>
              {o.permissions.includes('org:delete') ? (
                <div className="rounded-lg border border-destructive/40 p-4">
                  <p className="font-medium text-destructive">Delete organization</p>
                  <p className="mt-1 text-sm text-muted-foreground">Removes the organization and all its datasets. Stored files are purged by a background job.</p>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      if (prompt(`Type "${o.slug}" to confirm`) === o.slug) del.mutate();
                    }}
                  >
                    Delete organization
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}

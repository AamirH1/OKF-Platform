'use client';

import type { DatasetDTO, DatasetStatus, Page } from '@okf/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Building2, Database, Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { DatasetList } from '@/components/datasets';
import { EmptyState, ErrorState, LoadingRows, PageHeader, Stat } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useCurrentOrg, useRequireAuth } from '@/lib/session';

const STATUSES: DatasetStatus[] = ['PUBLISHED', 'VALIDATED', 'PROCESSING', 'FAILED'];

export default function DashboardPage() {
  const me = useRequireAuth();
  const { org } = useCurrentOrg();
  const recent = useQuery({
    queryKey: ['datasets', { organizationId: org?.id, pageSize: 6 }],
    queryFn: () => api<Page<DatasetDTO>>('/datasets', { query: { organizationId: org!.id, pageSize: 6, sort: 'updated' } }),
    enabled: !!org,
    refetchInterval: (q) => (q.state.data?.data.some((d) => d.status === 'PROCESSING') ? 3000 : false),
  });
  const counts = useQueries({
    queries: STATUSES.map((status) => ({
      queryKey: ['datasets', 'count', org?.id, status],
      queryFn: () => api<Page<DatasetDTO>>('/datasets', { query: { organizationId: org!.id, status, pageSize: 1 } }),
      enabled: !!org,
    })),
  });

  if (me === undefined) return <LoadingRows />;
  if (!org) {
    return (
      <>
        <PageHeader title={`Welcome, ${me?.user.name ?? ''}`} />
        <EmptyState
          icon={Building2}
          title="Create your first organization"
          description="Datasets belong to organizations. Create one to start uploading OKF bundles and inviting teammates."
          action={
            <Button asChild>
              <Link href="/organizations">
                <Plus /> New organization
              </Link>
            </Button>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Knowledge bundles in ${org.name}`}
        actions={
          <Button asChild>
            <Link href="/datasets/new">
              <Upload /> New dataset
            </Link>
          </Button>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {STATUSES.map((s, i) => (
          <Stat key={s} label={s.toLowerCase()} value={counts[i]?.data?.page.total ?? '—'} />
        ))}
      </div>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Recently updated</CardTitle>
          <Link href="/datasets" className="text-sm text-primary">
            View all
          </Link>
        </CardHeader>
        <CardContent>
          {recent.isLoading ? (
            <LoadingRows rows={3} />
          ) : recent.error ? (
            <ErrorState error={recent.error} retry={() => void recent.refetch()} />
          ) : recent.data && recent.data.data.length > 0 ? (
            <DatasetList datasets={recent.data.data} />
          ) : (
            <EmptyState icon={Database} title="No datasets yet" description="Create a dataset, then upload an OKF bundle (.zip, .tar.gz or .md)." action={<Button asChild><Link href="/datasets/new">Create dataset</Link></Button>} />
          )}
        </CardContent>
      </Card>
    </>
  );
}

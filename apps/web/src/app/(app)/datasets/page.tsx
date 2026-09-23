'use client';

import { DATASET_STATUSES, type DatasetDTO, type Page } from '@okf/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Database, Plus } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { DatasetList } from '@/components/datasets';
import { EmptyState, ErrorState, LoadingRows, PageHeader, Pagination } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useCurrentOrg, useRequireAuth } from '@/lib/session';

export default function DatasetsPage() {
  useRequireAuth();
  const { org } = useCurrentOrg();
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [sort, setSort] = React.useState('updated');
  const [page, setPage] = React.useState(1);
  React.useEffect(() => {
    const t = setTimeout(() => (setDebounced(q), setPage(1)), 300);
    return () => clearTimeout(t);
  }, [q]);
  const params = { organizationId: org?.id, q: debounced, status, sort, page, pageSize: 20 };
  const list = useQuery({
    queryKey: ['datasets', params],
    queryFn: () => api<Page<DatasetDTO>>('/datasets', { query: params }),
    enabled: !!org,
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader
        title="Datasets"
        description={org ? `OKF bundles in ${org.name}` : undefined}
        actions={
          org && org.role !== 'viewer' ? (
            <Button asChild>
              <Link href="/datasets/new">
                <Plus /> New dataset
              </Link>
            </Button>
          ) : null
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <Input placeholder="Filter by name or content…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter datasets" className="sm:max-w-xs" />
        <Select value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} aria-label="Status" className="sm:w-40">
          <option value="">All statuses</option>
          {DATASET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.toLowerCase()}
            </option>
          ))}
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort" className="sm:w-44">
          <option value="updated">Recently updated</option>
          <option value="created">Recently created</option>
          <option value="name">Name</option>
        </Select>
      </div>
      {!org ? (
        <EmptyState title="Join or create an organization first" action={<Button asChild><Link href="/organizations">Organizations</Link></Button>} />
      ) : list.isLoading ? (
        <LoadingRows />
      ) : list.error ? (
        <ErrorState error={list.error} retry={() => void list.refetch()} />
      ) : list.data!.data.length === 0 ? (
        <EmptyState icon={Database} title="No datasets match" />
      ) : (
        <>
          <DatasetList datasets={list.data!.data} />
          <Pagination page={page} pageSize={20} total={list.data!.page.total} onPage={setPage} />
        </>
      )}
    </>
  );
}

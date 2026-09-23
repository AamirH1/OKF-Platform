'use client';

import type { DatasetDTO, Page } from '@okf/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LibraryBig } from 'lucide-react';
import * as React from 'react';
import { EmptyState, ErrorState, LoadingRows, PageHeader, Pagination } from '@/components/common';
import { DatasetList } from '@/components/datasets';
import { Input, Select } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useMe } from '@/lib/session';

/** Browse every dataset visible to the viewer (public ones for signed-out visitors). */
export default function CatalogPage() {
  const { data: me } = useMe();
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [tag, setTag] = React.useState('');
  const [visibility, setVisibility] = React.useState('');
  const [orgId, setOrgId] = React.useState('');
  const [sort, setSort] = React.useState('updated');
  const [page, setPage] = React.useState(1);
  React.useEffect(() => {
    const t = setTimeout(() => (setDebounced(q), setPage(1)), 300);
    return () => clearTimeout(t);
  }, [q]);
  const query = { q: debounced, tag: tag.trim().toLowerCase(), visibility, organizationId: orgId, sort, page, pageSize: 20 };
  const list = useQuery({ queryKey: ['catalog', query], queryFn: () => api<Page<DatasetDTO>>('/datasets', { query }), placeholderData: keepPreviousData });

  return (
    <>
      <PageHeader title="Catalog" description={me ? 'Datasets you can access across your organizations, plus public datasets.' : 'Public OKF knowledge bundles.'} />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter catalog" className="lg:col-span-2" />
        <Input placeholder="Tag" value={tag} onChange={(e) => (setTag(e.target.value), setPage(1))} aria-label="Tag" />
        {me ? (
          <Select value={orgId} onChange={(e) => (setOrgId(e.target.value), setPage(1))} aria-label="Organization">
            <option value="">All organizations</option>
            {me.organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        ) : null}
        <div className="flex gap-2">
          {me ? (
            <Select value={visibility} onChange={(e) => (setVisibility(e.target.value), setPage(1))} aria-label="Visibility">
              <option value="">Any visibility</option>
              <option value="public">Public</option>
              <option value="organization">Organization</option>
              <option value="private">Private</option>
            </Select>
          ) : null}
          <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
            <option value="updated">Updated</option>
            <option value="name">Name</option>
            <option value="created">Created</option>
          </Select>
        </div>
      </div>
      {list.isLoading ? <LoadingRows /> : list.error ? <ErrorState error={list.error} /> : list.data!.data.length === 0 ? (
        <EmptyState icon={LibraryBig} title="No datasets found" />
      ) : (
        <>
          <DatasetList datasets={list.data!.data} />
          <Pagination page={page} pageSize={20} total={list.data!.page.total} onPage={setPage} />
        </>
      )}
    </>
  );
}

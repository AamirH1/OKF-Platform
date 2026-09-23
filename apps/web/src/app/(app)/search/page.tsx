'use client';

import type { Page, SearchHitDTO } from '@okf/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { EmptyState, ErrorState, LoadingRows, PageHeader, Pagination } from '@/components/common';
import { SearchResults } from '@/components/search-results';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/primitives';
import { api } from '@/lib/api';

function SearchInner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const q = params.get('q') ?? '';
  const scope = params.get('scope') === 'concepts' ? 'concepts' : 'datasets';
  const sort = params.get('sort') ?? 'relevance';
  const page = Number(params.get('page') ?? '1') || 1;
  const [input, setInput] = React.useState(q);
  React.useEffect(() => setInput(q), [q]);
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    router.push(`${pathname}?${next}`);
  };
  const results = useQuery({
    queryKey: ['search', { q, scope, sort, page }],
    queryFn: () => api<Page<SearchHitDTO>>('/search', { query: { q, scope, sort, page, pageSize: 20 } }),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title="Search" description="Full-text search over dataset names, descriptions, tags, organizations, concept titles, types, bodies and schema column names." />
      <form className="mb-4 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => (e.preventDefault(), set({ q: input.trim() }))} role="search">
        <Input autoFocus placeholder="e.g. revenue, customer_id, BigQuery Table" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Search query" className="sm:max-w-lg" />
        <Select value={scope} onChange={(e) => set({ scope: e.target.value })} aria-label="Search in" className="sm:w-40">
          <option value="datasets">Datasets</option>
          <option value="concepts">Concepts</option>
        </Select>
        <Select value={sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort" className="sm:w-40">
          <option value="relevance">Relevance</option>
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
        </Select>
        <Button type="submit">
          <Search /> Search
        </Button>
      </form>
      {!q ? (
        <EmptyState icon={Search} title="Search the catalog" description="Signed-out visitors see public published datasets; members also see their organizations' datasets." />
      ) : results.isLoading ? (
        <LoadingRows />
      ) : results.error ? (
        <ErrorState error={results.error} />
      ) : results.data!.data.length === 0 ? (
        <EmptyState icon={Search} title={`No results for "${q}"`} description={scope === 'datasets' ? 'Try searching concepts instead.' : undefined} />
      ) : (
        <>
          <SearchResults results={results.data!} />
          <Pagination page={page} pageSize={20} total={results.data!.page.total} onPage={(p) => set({ page: String(p) })} />
        </>
      )}
    </>
  );
}

export default function SearchPage() {
  return (
    <React.Suspense fallback={<LoadingRows />}>
      <SearchInner />
    </React.Suspense>
  );
}

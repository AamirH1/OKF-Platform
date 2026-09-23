'use client';

import type { AuditLogDTO, Page } from '@okf/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { AuditTable } from '@/components/audit';
import { ErrorState, LoadingRows, Pagination } from '@/components/common';
import { useDataset } from '@/components/dataset-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';
import { api } from '@/lib/api';

export default function ActivityPage() {
  const { dataset: d } = useDataset();
  const [page, setPage] = React.useState(1);
  const q = useQuery({
    queryKey: ['activity', d.id, page],
    queryFn: () => api<Page<AuditLogDTO>>(`/datasets/${d.id}/activity`, { query: { page, pageSize: 30 } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Uploads, processing results, publishing, sharing and queries on this dataset.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} /> : (
          <>
            <AuditTable entries={q.data!.data} />
            <Pagination page={page} pageSize={30} total={q.data!.page.total} onPage={setPage} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

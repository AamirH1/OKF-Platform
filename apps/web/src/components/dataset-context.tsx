'use client';

import type { DatasetDTO, Page, VersionDTO } from '@okf/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { api, setShareToken } from '@/lib/api';

interface DatasetContextValue {
  dataset: DatasetDTO;
  /** Version number selected via `?version=`, or undefined for the default version. */
  versionParam: number | undefined;
  /** Query string to append to links so the selected version sticks across tabs. */
  versionQs: string;
  shared: boolean;
  refetch: () => void;
}

const Ctx = React.createContext<DatasetContextValue | null>(null);

export function useDataset(): DatasetContextValue {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useDataset must be used inside a dataset page');
  return v;
}

export const shareKey = (datasetId: string) => `okf.share.${datasetId}`;

/** Fetch the dataset for the current route, applying a stored share-link token if any. */
export function DatasetProvider({ children, fallback, error }: { children: React.ReactNode; fallback: React.ReactNode; error: (e: unknown, retry: () => void) => React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const [shared, setShared] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let token: string | null = null;
    try {
      token = sessionStorage.getItem(shareKey(id));
    } catch {
      // storage unavailable
    }
    setShareToken(token);
    setShared(!!token);
    return () => setShareToken(null);
  }, [id]);
  const q = useQuery({
    queryKey: ['dataset', id],
    queryFn: () => api<DatasetDTO>(`/datasets/${id}`),
    enabled: shared !== null,
    refetchInterval: (query) => (query.state.data?.latestVersion?.status === 'PROCESSING' ? 3000 : false),
  });
  const raw = params.get('version');
  const versionParam = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
  if (q.isLoading || shared === null) return <>{fallback}</>;
  if (q.error || !q.data) return <>{error(q.error, () => void q.refetch())}</>;
  return (
    <Ctx.Provider value={{ dataset: q.data, versionParam, versionQs: versionParam ? `?version=${versionParam}` : '', shared: !!shared, refetch: () => void q.refetch() }}>
      {children}
    </Ctx.Provider>
  );
}

export function useVersions(datasetId: string, enabled = true) {
  return useQuery({
    queryKey: ['versions', datasetId],
    queryFn: () => api<Page<VersionDTO>>(`/datasets/${datasetId}/versions`, { query: { pageSize: 100 } }),
    enabled,
    refetchInterval: (q) => (q.state.data?.data.some((v) => v.status === 'PROCESSING') ? 3000 : false),
  });
}

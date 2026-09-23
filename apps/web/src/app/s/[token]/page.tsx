'use client';

import type { DatasetDTO } from '@okf/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { ErrorState, LoadingRows } from '@/components/common';
import { shareKey } from '@/components/dataset-context';
import { api } from '@/lib/api';

/**
 * Share-link landing: resolve the token, remember it for this tab (sessionStorage), and open
 * the dataset. Subsequent requests send it as `x-share-token`; it grants published-only access.
 */
export default function SharedLinkPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const q = useQuery({ queryKey: ['shared', token], queryFn: () => api<DatasetDTO>(`/shared/${encodeURIComponent(token)}`), retry: false });
  React.useEffect(() => {
    if (!q.data) return;
    try {
      sessionStorage.setItem(shareKey(q.data.id), token);
    } catch {
      // storage unavailable: access will fall back to whatever the viewer already has
    }
    router.replace(`/datasets/${q.data.id}`);
  }, [q.data, router, token]);
  return <div className="mx-auto max-w-2xl px-4 py-16">{q.error ? <ErrorState error={q.error} /> : <LoadingRows rows={3} />}</div>;
}

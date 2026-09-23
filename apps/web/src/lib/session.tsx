'use client';

import type { MeDTO, MembershipDTO } from '@okf/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, isApiError } from './api';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<MeDTO>('/users/me');
      } catch (e) {
        if (isApiError(e, 401)) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

/** Redirect to /login when signed out. Returns the session once known. */
export function useRequireAuth(): MeDTO | null | undefined {
  const { data, isLoading } = useMe();
  const router = useRouter();
  React.useEffect(() => {
    if (!isLoading && data === null) {
      const next = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/dashboard';
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [data, isLoading, router]);
  return isLoading ? undefined : data;
}

const ORG_KEY = 'okf.currentOrg';

/**
 * The organization the user is working in. Stored per browser (a convenience only —
 * the API authorizes every request independently).
 */
export function useCurrentOrg(): { org: MembershipDTO | null; orgs: MembershipDTO[]; setOrg: (id: string) => void } {
  const { data } = useMe();
  const orgs = React.useMemo(() => data?.organizations ?? [], [data]);
  const [selected, setSelected] = React.useState<string | null>(null);
  React.useEffect(() => {
    try {
      setSelected(localStorage.getItem(ORG_KEY));
    } catch {
      // storage unavailable (private mode); fall back to the first organization
    }
  }, []);
  const org = orgs.find((o) => o.id === selected) ?? orgs[0] ?? null;
  const setOrg = React.useCallback((id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(ORG_KEY, id);
    } catch {
      // ignore
    }
  }, []);
  return { org, orgs, setOrg };
}

export function useSignOut() {
  const qc = useQueryClient();
  const router = useRouter();
  return async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      qc.clear();
      router.replace('/login');
    }
  };
}

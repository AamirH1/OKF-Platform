'use client';

import type { MeDTO } from '@okf/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { LoadingRows, PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardContent } from '@/components/ui/primitives';
import { api, type ApiError } from '@/lib/api';
import { useMe } from '@/lib/session';

function AcceptInner() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const accept = useMutation({
    mutationFn: () => api<MeDTO>('/invitations/accept', { method: 'POST', body: { token } }),
    onSuccess: (m) => {
      qc.setQueryData(['me'], m);
      router.replace('/dashboard');
    },
    onError: () => undefined,
  });
  const here = `/invitations/accept?token=${encodeURIComponent(token)}`;
  if (isLoading) return <LoadingRows />;
  return (
    <>
      <PageHeader title="Join organization" />
      <Card className="max-w-lg">
        <CardContent className="space-y-4 pt-5">
          {!token ? <Alert tone="danger">This invitation link is incomplete.</Alert> : null}
          {!me ? (
            <>
              <p className="text-sm">Sign in or create an account with the email address the invitation was sent to.</p>
              <div className="flex gap-2">
                <Button asChild>
                  <Link href={`/login?next=${encodeURIComponent(here)}`}>Sign in</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href={`/signup?next=${encodeURIComponent(here)}`}>Create account</Link>
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm">
                You are signed in as <strong>{me.user.email}</strong>.
              </p>
              {accept.error ? <Alert tone="danger">{(accept.error as ApiError).message}</Alert> : null}
              <Button onClick={() => accept.mutate()} disabled={!token || accept.isPending}>
                Accept invitation
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default function AcceptInvitationPage() {
  return (
    <React.Suspense fallback={<LoadingRows />}>
      <AcceptInner />
    </React.Suspense>
  );
}

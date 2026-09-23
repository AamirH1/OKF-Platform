'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordSchema, type SessionDTO } from '@okf/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState, LoadingRows, PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useRequireAuth } from '@/lib/session';
import { formatDate, timeAgo } from '@/lib/utils';

export default function ProfilePage() {
  const me = useRequireAuth();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  React.useEffect(() => setName(me?.user.name ?? ''), [me?.user.name]);
  const saveName = useMutation({
    mutationFn: () => api('/users/me', { method: 'PATCH', body: { name } }),
    onSuccess: (updated) => {
      qc.setQueryData(['me'], updated);
      toast.success('Profile updated');
    },
  });
  const pwForm = useForm<z.input<typeof changePasswordSchema>>({ resolver: zodResolver(changePasswordSchema), defaultValues: { currentPassword: '', newPassword: '' } });
  const changePw = useMutation({
    mutationFn: (v: z.input<typeof changePasswordSchema>) => api('/users/me/password', { method: 'POST', body: v }),
    onSuccess: () => {
      pwForm.reset();
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      toast.success('Password changed. Other sessions were signed out.');
    },
  });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ data: SessionDTO[] }>('/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
  });

  if (!me) return <LoadingRows />;
  return (
    <>
      <PageHeader title="Profile" description={me.user.email} />
      <div className="max-w-3xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Name</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), saveName.mutate())}>
              <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm" />
              <Button type="submit" variant="outline" disabled={!name.trim() || name === me.user.name}>
                Save
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
            <CardDescription>Changing it signs out all your other sessions.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="max-w-sm space-y-3" onSubmit={pwForm.handleSubmit((v) => changePw.mutate(v))} noValidate>
              <Field label="Current password" htmlFor="current" error={pwForm.formState.errors.currentPassword?.message}>
                <Input id="current" type="password" autoComplete="current-password" {...pwForm.register('currentPassword')} />
              </Field>
              <Field label="New password" htmlFor="new" error={pwForm.formState.errors.newPassword?.message}>
                <Input id="new" type="password" autoComplete="new-password" {...pwForm.register('newPassword')} />
              </Field>
              <Button type="submit" disabled={changePw.isPending}>
                Change password
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active sessions</CardTitle>
          </CardHeader>
          <CardContent>
            {sessions.isLoading ? <LoadingRows rows={2} /> : sessions.error ? <ErrorState error={sessions.error} /> : (
              <Table>
                <THead>
                  <TR>
                    <TH>Device</TH>
                    <TH>IP</TH>
                    <TH>Last active</TH>
                    <TH>Expires</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {sessions.data!.data.map((s) => (
                    <TR key={s.id}>
                      <TD className="max-w-xs truncate text-xs" title={s.userAgent ?? ''}>
                        {s.current ? <Badge tone="success" className="mr-1">this device</Badge> : null}
                        {s.userAgent ?? 'Unknown'}
                      </TD>
                      <TD className="font-mono text-xs">{s.ip}</TD>
                      <TD className="text-xs">{timeAgo(s.lastSeenAt)}</TD>
                      <TD className="text-xs text-muted-foreground">{formatDate(s.expiresAt)}</TD>
                      <TD className="text-right">
                        {!s.current ? (
                          <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)}>
                            Sign out
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

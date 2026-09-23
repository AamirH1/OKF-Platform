'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { canAssignRole, type InvitationDTO, inviteMemberSchema, type MemberDTO, ORG_ROLES, type OrgDTO, type OrgRole } from '@okf/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, MailPlus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { ErrorState, LoadingRows } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/overlays';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useMe } from '@/lib/session';
import { formatDate } from '@/lib/utils';

function InviteDialog({ org }: { org: OrgDTO }) {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [link, setLink] = React.useState<string | null>(null);
  const form = useForm<z.input<typeof inviteMemberSchema>>({ resolver: zodResolver(inviteMemberSchema), defaultValues: { email: '', role: 'viewer' } });
  const invite = useMutation({
    mutationFn: (v: z.input<typeof inviteMemberSchema>) => api<InvitationDTO>(`/organizations/${org.id}/invitations`, { method: 'POST', body: v }),
    onSuccess: (inv) => {
      void qc.invalidateQueries({ queryKey: ['invitations', org.id] });
      setLink(inv.acceptUrl ?? null);
      toast.success(`Invitation sent to ${inv.email}`);
    },
  });
  const roles = ORG_ROLES.filter((r) => canAssignRole(org.role, null, r));
  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), o || (setLink(null), form.reset()))}>
      <DialogTrigger asChild>
        <Button size="sm">
          <MailPlus /> Invite
        </Button>
      </DialogTrigger>
      <DialogContent title="Invite a member" description="They receive an email with a link valid for 7 days. They must sign in with this email to accept.">
        {link ? (
          <div className="space-y-3">
            <p className="text-sm">You can also share this link directly:</p>
            <div className="flex gap-2">
              <Input readOnly value={link} className="font-mono text-xs" />
              <Button variant="outline" size="icon" aria-label="Copy link" onClick={() => void navigator.clipboard.writeText(link).then(() => toast.success('Copied'))}>
                <Copy />
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={form.handleSubmit((v) => invite.mutate(v))} className="space-y-4" noValidate>
            <Field label="Email" htmlFor="invite-email" error={form.formState.errors.email?.message}>
              <Input id="invite-email" type="email" {...form.register('email')} />
            </Field>
            <Field label="Role" htmlFor="invite-role">
              <Select id="invite-role" {...form.register('role')}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" disabled={invite.isPending}>
              Send invitation
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function OrgMembers({ org }: { org: OrgDTO }) {
  const qc = useQueryClient();
  const router = useRouter();
  const { data: me } = useMe();
  const members = useQuery({ queryKey: ['members', org.id], queryFn: () => api<{ data: MemberDTO[] }>(`/organizations/${org.id}/members`) });
  const canManage = org.permissions.includes('members:manage');
  const invites = useQuery({
    queryKey: ['invitations', org.id],
    queryFn: () => api<{ data: InvitationDTO[] }>(`/organizations/${org.id}/invitations`),
    enabled: org.permissions.includes('invitations:manage'),
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) => api(`/organizations/${org.id}/members/${userId}`, { method: 'PATCH', body: { role } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['members', org.id] });
      toast.success('Role updated');
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api(`/organizations/${org.id}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: (_d, userId) => {
      void qc.invalidateQueries({ queryKey: ['members', org.id] });
      if (userId === me?.user.id) {
        void qc.invalidateQueries({ queryKey: ['me'] });
        router.replace('/organizations');
      }
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/organizations/${org.id}/invitations/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invitations', org.id] }),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Members</CardTitle>
            <CardDescription>Owners and admins manage members; editors create and upload datasets; viewers read.</CardDescription>
          </div>
          {org.permissions.includes('invitations:manage') ? <InviteDialog org={org} /> : null}
        </CardHeader>
        <CardContent>
          {members.isLoading ? (
            <LoadingRows rows={3} />
          ) : members.error ? (
            <ErrorState error={members.error} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Role</TH>
                  <TH>Joined</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {members.data!.data.map((m) => {
                  const self = m.userId === me?.user.id;
                  const assignable = ORG_ROLES.filter((r) => canAssignRole(org.role, m.role, r));
                  return (
                    <TR key={m.userId}>
                      <TD className="font-medium">
                        {m.name} {self ? <Badge tone="outline">you</Badge> : null}
                      </TD>
                      <TD className="text-muted-foreground">{m.email}</TD>
                      <TD>
                        {canManage && !self && assignable.includes(m.role) ? (
                          <Select aria-label={`Role for ${m.name}`} value={m.role} className="h-8 w-28" onChange={(e) => changeRole.mutate({ userId: m.userId, role: e.target.value as OrgRole })}>
                            {assignable.map((r) => (
                              <option key={r}>{r}</option>
                            ))}
                          </Select>
                        ) : (
                          <Badge tone={m.role === 'owner' ? 'primary' : 'default'}>{m.role}</Badge>
                        )}
                      </TD>
                      <TD className="text-muted-foreground">{formatDate(m.createdAt)}</TD>
                      <TD className="text-right">
                        {self || (canManage && canAssignRole(org.role, m.role, 'viewer')) ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              if (confirm(self ? `Leave ${org.name}?` : `Remove ${m.name} from ${org.name}?`)) remove.mutate(m.userId);
                            }}
                          >
                            {self ? 'Leave' : 'Remove'}
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {invites.data && invites.data.data.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Email</TH>
                  <TH>Role</TH>
                  <TH>Invited by</TH>
                  <TH>Expires</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {invites.data.data.map((i) => (
                  <TR key={i.id}>
                    <TD>{i.email}</TD>
                    <TD>{i.role}</TD>
                    <TD className="text-muted-foreground">{i.invitedBy?.name ?? '—'}</TD>
                    <TD className="text-muted-foreground">{formatDate(i.expiresAt)}</TD>
                    <TD className="text-right">
                      <Button variant="ghost" size="icon" aria-label={`Revoke invitation for ${i.email}`} onClick={() => revoke.mutate(i.id)}>
                        <Trash2 />
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

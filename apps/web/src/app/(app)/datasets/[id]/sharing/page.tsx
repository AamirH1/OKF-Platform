'use client';

import type { GrantDTO, ShareLinkDTO, Visibility } from '@okf/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { ErrorState, LoadingRows } from '@/components/common';
import { useDataset } from '@/components/dataset-context';
import { Button } from '@/components/ui/button';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Select, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';

const VIS: { value: Visibility; label: string; hint: string }[] = [
  { value: 'private', label: 'Private', hint: 'You, organization owners/admins, and people granted access below.' },
  { value: 'organization', label: 'Organization', hint: 'Every member of the organization (roles decide what they can do).' },
  { value: 'public', label: 'Public', hint: 'Anyone, including signed-out visitors — only the published version, never drafts.' },
];

export default function SharingPage() {
  const { dataset: d } = useDataset();
  const qc = useQueryClient();
  const grants = useQuery({ queryKey: ['grants', d.id], queryFn: () => api<{ data: GrantDTO[] }>(`/datasets/${d.id}/grants`) });
  const links = useQuery({ queryKey: ['share-links', d.id], queryFn: () => api<{ data: ShareLinkDTO[] }>(`/datasets/${d.id}/share-links`) });
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<'viewer' | 'editor'>('viewer');
  const [label, setLabel] = React.useState('');
  const [newLink, setNewLink] = React.useState<string | null>(null);

  const setVisibility = useMutation({
    mutationFn: (visibility: Visibility) => api(`/datasets/${d.id}/visibility`, { method: 'PUT', body: { visibility } }),
    onSuccess: (updated) => {
      qc.setQueryData(['dataset', d.id], updated);
      toast.success('Visibility updated');
    },
  });
  const grant = useMutation({
    mutationFn: () => api(`/datasets/${d.id}/grants`, { method: 'POST', body: { email, role } }),
    onSuccess: () => {
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['grants', d.id] });
      toast.success('Access granted');
    },
  });
  const revokeGrant = useMutation({
    mutationFn: (userId: string) => api(`/datasets/${d.id}/grants/${userId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['grants', d.id] }),
  });
  const createLink = useMutation({
    mutationFn: () => api<ShareLinkDTO>(`/datasets/${d.id}/share-links`, { method: 'POST', body: { label, expiresInDays: 30 } }),
    onSuccess: (l) => {
      setLabel('');
      setNewLink(`${window.location.origin}/s/${l.token}`);
      void qc.invalidateQueries({ queryKey: ['share-links', d.id] });
    },
  });
  const revokeLink = useMutation({
    mutationFn: (id: string) => api(`/datasets/${d.id}/share-links/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['share-links', d.id] }),
  });

  if (!d.permissions.includes('dataset:share')) return <Alert tone="warning">Only dataset managers can change sharing.</Alert>;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Visibility</CardTitle>
          <CardDescription>Who can find and read this dataset.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-3">
          {VIS.map((v) => (
            <button
              key={v.value}
              onClick={() => setVisibility.mutate(v.value)}
              aria-pressed={d.visibility === v.value}
              className={`rounded-lg border p-3 text-left ${d.visibility === v.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
            >
              <p className="font-medium">{v.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">{v.hint}</p>
            </button>
          ))}
          {d.visibility === 'public' && !d.publishedVersion ? (
            <Alert tone="info" className="sm:col-span-3">
              Not visible to the public yet: publish a version first.
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>People with access</CardTitle>
          <CardDescription>Grant specific users access (useful for private datasets and people outside the organization).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="flex flex-wrap gap-2" onSubmit={(e) => (e.preventDefault(), grant.mutate())}>
            <Input type="email" required placeholder="user@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" className="w-64" />
            <Select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')} aria-label="Access role" className="w-32">
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
            </Select>
            <Button type="submit" disabled={!email || grant.isPending}>
              Grant access
            </Button>
          </form>
          {grants.isLoading ? <LoadingRows rows={2} /> : grants.error ? <ErrorState error={grants.error} /> : grants.data!.data.length ? (
            <Table>
              <THead>
                <TR>
                  <TH>User</TH>
                  <TH>Role</TH>
                  <TH>Since</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {grants.data!.data.map((g) => (
                  <TR key={g.user.id}>
                    <TD>
                      {g.user.name} <span className="text-muted-foreground">({g.user.email})</span>
                    </TD>
                    <TD>
                      <Badge>{g.role}</Badge>
                    </TD>
                    <TD className="text-xs text-muted-foreground">{formatDate(g.createdAt)}</TD>
                    <TD className="text-right">
                      <Button variant="ghost" size="icon" aria-label={`Revoke ${g.user.email}`} onClick={() => revokeGrant.mutate(g.user.id)}>
                        <Trash2 />
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Share links</CardTitle>
          <CardDescription>Anyone with a link can read and query the published version (never drafts). Links expire after 30 days and can be revoked.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="flex flex-wrap gap-2" onSubmit={(e) => (e.preventDefault(), createLink.mutate())}>
            <Input placeholder="Label (e.g. partner name)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Link label" className="w-64" />
            <Button type="submit" disabled={createLink.isPending}>
              <Link2 /> Create link
            </Button>
          </form>
          {newLink ? (
            <Alert tone="success" title="Copy this link now — it will not be shown again">
              <div className="mt-2 flex gap-2">
                <Input readOnly value={newLink} className="font-mono text-xs" aria-label="New share link" />
                <Button variant="outline" size="icon" aria-label="Copy link" onClick={() => void navigator.clipboard.writeText(newLink).then(() => toast.success('Copied'))}>
                  <Copy />
                </Button>
              </div>
            </Alert>
          ) : null}
          {links.data && links.data.data.length ? (
            <Table>
              <THead>
                <TR>
                  <TH>Label</TH>
                  <TH>Created</TH>
                  <TH>Expires</TH>
                  <TH>Last used</TH>
                  <TH>Status</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {links.data.data.map((l) => (
                  <TR key={l.id}>
                    <TD>{l.label || '—'}</TD>
                    <TD className="text-xs text-muted-foreground">{formatDate(l.createdAt)}</TD>
                    <TD className="text-xs text-muted-foreground">{formatDate(l.expiresAt)}</TD>
                    <TD className="text-xs text-muted-foreground">{formatDate(l.lastUsedAt)}</TD>
                    <TD>{l.revokedAt ? <Badge tone="danger">revoked</Badge> : <Badge tone="success">active</Badge>}</TD>
                    <TD className="text-right">
                      {!l.revokedAt ? (
                        <Button variant="ghost" size="sm" onClick={() => revokeLink.mutate(l.id)}>
                          Revoke
                        </Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

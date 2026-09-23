'use client';

import { API_KEY_SCOPES, type ApiKeyDTO, type ApiKeyScope } from '@okf/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useCurrentOrg, useRequireAuth } from '@/lib/session';
import { formatDate, timeAgo } from '@/lib/utils';

const SCOPE_HELP: Record<ApiKeyScope, string> = {
  'datasets:read': 'Read datasets, versions, preview, query, download',
  'datasets:write': 'Create datasets, upload versions, edit metadata',
  'datasets:publish': 'Publish and unpublish versions',
};

export default function ApiKeysPage() {
  useRequireAuth();
  const { org } = useCurrentOrg();
  const qc = useQueryClient();
  const [name, setName] = React.useState('');
  const [scopes, setScopes] = React.useState<ApiKeyScope[]>(['datasets:read']);
  const [expires, setExpires] = React.useState('90');
  const [created, setCreated] = React.useState<ApiKeyDTO | null>(null);
  const keys = useQuery({ queryKey: ['api-keys', org?.id], queryFn: () => api<{ data: ApiKeyDTO[] }>('/api-keys', { query: { organizationId: org!.id } }), enabled: !!org });
  const create = useMutation({
    mutationFn: () => api<ApiKeyDTO>('/api-keys', { method: 'POST', body: { organizationId: org!.id, name, scopes, expiresInDays: expires ? Number(expires) : null } }),
    onSuccess: (k) => {
      setCreated(k);
      setName('');
      void qc.invalidateQueries({ queryKey: ['api-keys', org?.id] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['api-keys', org?.id] }),
  });

  if (!org) return <EmptyState title="No organization selected" />;
  return (
    <>
      <PageHeader title="API keys" description={`Programmatic access to ${org.name}. A key acts with your current role, limited to its scopes. Only a hash is stored.`} />
      <div className="max-w-4xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Create a key</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), create.mutate())}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="key-name">
                  <Input id="key-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="CI pipeline" />
                </Field>
                <Field label="Expires" htmlFor="key-exp">
                  <Select id="key-exp" value={expires} onChange={(e) => setExpires(e.target.value)}>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                    <option value="365">1 year</option>
                    <option value="">Never</option>
                  </Select>
                </Field>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Scopes</legend>
                {API_KEY_SCOPES.map((s) => (
                  <label key={s} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5" checked={scopes.includes(s)} onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />
                    <span>
                      <code>{s}</code> <span className="text-muted-foreground">— {SCOPE_HELP[s]}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <Button type="submit" disabled={!name || scopes.length === 0 || create.isPending}>
                <KeyRound /> Create key
              </Button>
            </form>
          </CardContent>
        </Card>
        {created?.key ? (
          <Alert tone="success" title="Copy your key now — it will not be shown again">
            <div className="mt-2 flex gap-2">
              <Input readOnly value={created.key} className="font-mono text-xs" aria-label="New API key" data-testid="new-api-key" />
              <Button variant="outline" size="icon" aria-label="Copy key" onClick={() => void navigator.clipboard.writeText(created.key!).then(() => toast.success('Copied'))}>
                <Copy />
              </Button>
            </div>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{`curl -H "Authorization: Bearer ${created.key.slice(0, 16)}…" ${typeof window !== 'undefined' ? window.location.origin : ''}/api/v1/datasets`}</pre>
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Keys</CardTitle>
            {org.role === 'owner' || org.role === 'admin' ? <CardDescription>As an {org.role}, you see every key in the organization.</CardDescription> : null}
          </CardHeader>
          <CardContent>
            {keys.isLoading ? <LoadingRows rows={2} /> : keys.error ? <ErrorState error={keys.error} /> : keys.data!.data.length === 0 ? <EmptyState icon={KeyRound} title="No API keys" /> : (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Key</TH>
                    <TH>Scopes</TH>
                    <TH>Last used</TH>
                    <TH>Expires</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {keys.data!.data.map((k) => (
                    <TR key={k.id}>
                      <TD>
                        {k.name}
                        <p className="text-xs text-muted-foreground">{k.createdBy?.name}</p>
                      </TD>
                      <TD className="font-mono text-xs">{k.prefix}_…</TD>
                      <TD className="space-x-1">
                        {k.scopes.map((s) => (
                          <Badge key={s} tone="outline">
                            {s}
                          </Badge>
                        ))}
                      </TD>
                      <TD className="text-xs">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never'}</TD>
                      <TD className="text-xs text-muted-foreground">{k.expiresAt ? formatDate(k.expiresAt) : 'never'}</TD>
                      <TD className="text-right">
                        {k.revokedAt ? (
                          <Badge tone="danger">revoked</Badge>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => confirm(`Revoke "${k.name}"? Clients using it will stop working.`) && revoke.mutate(k.id)}>
                            Revoke
                          </Button>
                        )}
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

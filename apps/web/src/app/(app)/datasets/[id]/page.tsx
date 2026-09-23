'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { toast } from 'sonner';
import { EmptyState, ErrorState, LoadingRows, Stat, StatusBadge } from '@/components/common';
import { ConceptGraph } from '@/components/concept-graph';
import { useDataset } from '@/components/dataset-context';
import { BundleUploader, JobProgress } from '@/components/upload';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Progress, Textarea } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { formatBytes, formatDate, formatNumber, pct } from '@/lib/utils';

interface Profile {
  conceptCount: number;
  types: { value: string; count: number }[];
  trustTiers: Record<string, number>;
  statuses: Record<string, number>;
  staleCount: number;
  links: { total: number; internal: number; external: number; broken: number; conceptsWithoutInbound: number };
  coverage: Record<string, number>;
  qualityScore: number;
  assetSchemas: { conceptsWithSchema: number; totalColumns: number };
  computations: { count: number };
}

function Bars({ items, total }: { items: { label: string; value: number }[]; total: number }) {
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.label} className="text-sm">
          <div className="mb-1 flex justify-between gap-2">
            <span className="truncate">{i.label}</span>
            <span className="tabular-nums text-muted-foreground">{formatNumber(i.value)}</span>
          </div>
          <Progress value={total ? (i.value / total) * 100 : 0} label={i.label} className="h-1.5" />
        </li>
      ))}
    </ul>
  );
}

function EditMetadata() {
  const { dataset: d } = useDataset();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(d.name);
  const [description, setDescription] = React.useState(d.description);
  const [tags, setTags] = React.useState(d.tags.join(', '));
  const save = useMutation({
    mutationFn: () => api(`/datasets/${d.id}`, { method: 'PATCH', body: { name, description, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) } }),
    onSuccess: (updated) => {
      qc.setQueryData(['dataset', d.id], updated);
      setEditing(false);
      toast.success('Saved');
    },
  });
  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-4">
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{d.description || 'No description.'}</p>
        {d.permissions.includes('dataset:update') ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <Textarea aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      <Input aria-label="Tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Comma-separated tags" />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function OverviewPage() {
  const { dataset: d, versionParam, versionQs } = useDataset();
  const hasVersion = !!(d.latestVersion ?? d.publishedVersion);
  const meta = useQuery({
    queryKey: ['metadata', d.id, versionParam ?? 'default', d.latestVersion?.status],
    queryFn: () => api<{ version: number; okfVersion: string | null; profile: Profile | null }>(`/datasets/${d.id}/metadata`, { query: { version: versionParam } }),
    enabled: hasVersion,
  });
  const v = versionParam ? null : (d.latestVersion ?? d.publishedVersion);
  const p = meta.data?.profile;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <EditMetadata />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Organization</dt>
              <dd>{d.organization.name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">License</dt>
              <dd>{d.license ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{formatDate(d.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Usage (30 days)</dt>
              <dd>
                {d.usage.views} views · {d.usage.queries} queries · {d.usage.downloads} downloads · {d.usage.apiRequests} API
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {!hasVersion ? (
        d.permissions.includes('dataset:upload') ? (
          <Card>
            <CardHeader>
              <CardTitle>Upload the first version</CardTitle>
              <CardDescription>Upload an OKF bundle to validate, profile and index it.</CardDescription>
            </CardHeader>
            <CardContent>
              <BundleUploader datasetId={d.id} />
            </CardContent>
          </Card>
        ) : (
          <EmptyState title="No versions yet" />
        )
      ) : null}

      {v?.status === 'PROCESSING' && v.job ? (
        <Card>
          <CardHeader>
            <CardTitle>Processing v{v.number}</CardTitle>
          </CardHeader>
          <CardContent>
            <JobProgress jobId={v.job.id} />
          </CardContent>
        </Card>
      ) : null}

      {v?.status === 'FAILED' && v.failure ? (
        <Alert tone="danger" title={`Version ${v.number} failed${v.failure.stage ? ` at "${v.failure.stage}"` : ''}`}>
          <p>{v.failure.message}</p>
          <p className="mt-1 font-mono text-xs">{v.failure.code}</p>
          {v.valid === false ? (
            <Link href={`/datasets/${d.id}/validation?version=${v.number}`} className="mt-2 inline-block text-primary">
              Open the validation report
            </Link>
          ) : null}
        </Alert>
      ) : null}

      {hasVersion ? (
        meta.isLoading ? (
          <LoadingRows rows={3} />
        ) : meta.error ? (
          <ErrorState error={meta.error} />
        ) : p ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="Version" value={`v${meta.data!.version}`} hint={`OKF ${meta.data!.okfVersion ?? '—'}`} />
              <Stat label="Concepts" value={formatNumber(p.conceptCount)} hint={`${p.types.length} types`} />
              <Stat label="Size" value={formatBytes((v ?? d.publishedVersion)?.totalBytes)} hint={`${formatNumber((v ?? d.publishedVersion)?.fileCount)} files`} />
              <Stat label="Quality score" value={`${p.qualityScore}/100`} hint="Platform heuristic" />
              <Stat label="Links" value={formatNumber(p.links.internal)} hint={`${p.links.broken} broken · ${p.links.external} external`} />
            </div>
            <div className="grid gap-6 lg:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle>Concept types</CardTitle>
                  <CardDescription>OKF `type` values (free vocabulary).</CardDescription>
                </CardHeader>
                <CardContent>
                  <Bars items={p.types.slice(0, 8).map((t) => ({ label: t.value, value: t.count }))} total={p.conceptCount} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Trust & lifecycle</CardTitle>
                  <CardDescription>Derived from `verified`, `status`, `stale_after` (OKF §5).</CardDescription>
                </CardHeader>
                <CardContent>
                  <Bars
                    items={[
                      ...Object.entries(p.trustTiers).map(([label, value]) => ({ label, value })),
                      { label: 'stale', value: p.staleCount },
                      { label: 'deprecated', value: p.statuses.deprecated ?? 0 },
                    ]}
                    total={p.conceptCount}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Metadata coverage</CardTitle>
                  <CardDescription>Share of concepts with each field.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1.5 text-sm">
                    {Object.entries(p.coverage).map(([k, value]) => (
                      <li key={k} className="flex justify-between">
                        <span className="font-mono text-xs">{k}</span>
                        <span className="tabular-nums text-muted-foreground">{pct(value)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {p.assetSchemas.conceptsWithSchema} concepts document a schema ({p.assetSchemas.totalColumns} columns) · {p.computations.count} attested computations
                  </p>
                </CardContent>
              </Card>
            </div>
            <ConceptGraph datasetId={d.id} version={versionParam} versionQs={versionQs} />
            {v ? (
              <p className="text-sm text-muted-foreground">
                v{v.number} <StatusBadge status={v.status} /> · {v.valid ? 'OKF-conformant' : 'not conformant'} · {v.errorCount ?? 0} errors, {v.warningCount ?? 0} warnings ·{' '}
                <Link className="text-primary" href={`/datasets/${d.id}/validation${versionQs}`}>
                  validation report
                </Link>
              </p>
            ) : null}
          </>
        ) : null
      ) : null}
    </div>
  );
}

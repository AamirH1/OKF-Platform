'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GitCompare, Rocket } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { ErrorState, LoadingRows, StatusBadge } from '@/components/common';
import { useDataset, useVersions } from '@/components/dataset-context';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Select, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { formatBytes, formatDate, formatNumber } from '@/lib/utils';

export default function VersionsPage() {
  const { dataset: d } = useDataset();
  const versions = useVersions(d.id);
  const router = useRouter();
  const qc = useQueryClient();
  const [base, setBase] = React.useState('');
  const [target, setTarget] = React.useState('');
  const publish = useMutation({
    mutationFn: (version: number) => api(`/datasets/${d.id}/publish`, { method: 'POST', body: { version } }),
    onSuccess: (updated) => {
      qc.setQueryData(['dataset', d.id], updated);
      void qc.invalidateQueries({ queryKey: ['versions', d.id] });
      toast.success('Published');
    },
  });
  if (versions.isLoading) return <LoadingRows />;
  if (versions.error) return <ErrorState error={versions.error} />;
  const list = versions.data!.data;
  const comparable = list.filter((v) => v.status === 'VALIDATED' || v.status === 'PUBLISHED');

  return (
    <div className="space-y-6">
      {d.permissions.includes('dataset:read_drafts') && comparable.length >= 2 ? (
        <Card>
          <CardHeader>
            <CardTitle>Compare versions</CardTitle>
            <CardDescription>Concept, schema and field changes between two processed versions.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <Select aria-label="Base version" value={base} onChange={(e) => setBase(e.target.value)} className="w-32">
              <option value="">Base…</option>
              {comparable.map((v) => (
                <option key={v.id} value={v.number}>
                  v{v.number}
                </option>
              ))}
            </Select>
            <span className="pb-2 text-muted-foreground">→</span>
            <Select aria-label="Target version" value={target} onChange={(e) => setTarget(e.target.value)} className="w-32">
              <option value="">Target…</option>
              {comparable.map((v) => (
                <option key={v.id} value={v.number}>
                  v{v.number}
                </option>
              ))}
            </Select>
            <Button disabled={!base || !target || base === target} onClick={() => router.push(`/datasets/${d.id}/versions/compare?base=${base}&target=${target}`)}>
              <GitCompare /> Compare
            </Button>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
          <CardDescription>Versions are immutable once processed; publishing never changes their content.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table data-testid="versions-table">
            <THead>
              <TR>
                <TH>Version</TH>
                <TH>Status</TH>
                <TH>Concepts</TH>
                <TH>Validation</TH>
                <TH>Size</TH>
                <TH>Created</TH>
                <TH>Checksum</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {list.map((v) => (
                <TR key={v.id}>
                  <TD>
                    <Link href={`/datasets/${d.id}?version=${v.number}`} className="font-medium text-primary">
                      v{v.number}
                    </Link>
                    {d.publishedVersion?.id === v.id ? (
                      <Badge tone="success" className="ml-1.5">
                        current
                      </Badge>
                    ) : null}
                    <p className="max-w-56 truncate text-xs text-muted-foreground" title={v.originalFilename}>
                      {v.sourceType === 'import' ? 'Imported: ' : ''}
                      {v.originalFilename}
                    </p>
                    {v.notes ? <p className="max-w-56 truncate text-xs text-muted-foreground">{v.notes}</p> : null}
                  </TD>
                  <TD>
                    <StatusBadge status={v.status} />
                    {v.failure ? <p className="mt-1 max-w-48 text-xs text-destructive">{v.failure.code}</p> : null}
                  </TD>
                  <TD className="tabular-nums">{formatNumber(v.conceptCount)}</TD>
                  <TD className="text-sm">
                    {v.valid === null ? '—' : (
                      <Link href={`/datasets/${d.id}/validation?version=${v.number}`} className="hover:underline">
                        {v.errorCount} errors · {v.warningCount} warnings
                      </Link>
                    )}
                  </TD>
                  <TD className="tabular-nums text-sm">{formatBytes(v.archiveSize)}</TD>
                  <TD className="text-sm">
                    {formatDate(v.createdAt)}
                    <p className="text-xs text-muted-foreground">{v.createdBy?.name ?? ''}</p>
                  </TD>
                  <TD className="font-mono text-xs text-muted-foreground" title={v.archiveSha256 ?? ''}>
                    {v.archiveSha256 ? `${v.archiveSha256.slice(0, 12)}…` : '—'}
                  </TD>
                  <TD>
                    {d.permissions.includes('dataset:publish') && (v.status === 'VALIDATED' || v.status === 'PUBLISHED') && v.valid && d.publishedVersion?.id !== v.id ? (
                      <Button size="sm" variant="outline" onClick={() => publish.mutate(v.number)}>
                        <Rocket /> Publish
                      </Button>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

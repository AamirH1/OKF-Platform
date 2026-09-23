'use client';

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { ErrorState, LoadingRows } from '@/components/common';
import { useDataset } from '@/components/dataset-context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

interface MetaResponse {
  version: number;
  okfVersion: string | null;
  metadata: {
    okfVersion: string;
    declaredOkfVersion: string | null;
    conceptCount: number;
    types: string[];
    tags: string[];
    hasRootIndex: boolean;
    hasLog: boolean;
    ignoredFiles?: string[];
    indexes?: { path: string; entries: number }[];
    logs?: { path: string; groups: { date: string; entries: string[] }[] }[];
  } | null;
  profile: Record<string, unknown> | null;
}

export default function MetadataPage() {
  const { dataset: d, versionParam } = useDataset();
  const q = useQuery({ queryKey: ['metadata', d.id, versionParam ?? 'default'], queryFn: () => api<MetaResponse>(`/datasets/${d.id}/metadata`, { query: { version: versionParam } }) });
  const files = useQuery({
    queryKey: ['files', d.id, versionParam],
    queryFn: () => api<{ data: { path: string; kind: string; size: number; sha256: string }[]; page: { total: number } }>(`/datasets/${d.id}/files`, { query: { version: versionParam, pageSize: 1000 } }),
  });
  if (q.isLoading) return <LoadingRows />;
  if (q.error) return <ErrorState error={q.error} />;
  const m = q.data!.metadata;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Bundle metadata</CardTitle>
          <CardDescription>From the bundle structure (OKF §3, §8, §9, §12).</CardDescription>
        </CardHeader>
        <CardContent>
          {m ? (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">OKF version</dt>
                <dd>
                  {m.okfVersion} {m.declaredOkfVersion ? '(declared in index.md)' : '(assumed; not declared)'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Root index.md / log.md</dt>
                <dd>
                  {m.hasRootIndex ? 'yes' : 'no'} / {m.hasLog ? 'yes' : 'no'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Concept types</dt>
                <dd>{m.types.join(', ') || '—'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Concept tags</dt>
                <dd className="line-clamp-3">{m.tags.join(', ') || '—'}</dd>
              </div>
              {m.ignoredFiles && m.ignoredFiles.length > 0 ? (
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">Ignored files (hidden or archive artefacts)</dt>
                  <dd className="font-mono text-xs">{m.ignoredFiles.slice(0, 10).join(', ')}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Not available (version not processed).</p>
          )}
        </CardContent>
      </Card>
      {m?.logs && m.logs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Change log</CardTitle>
            <CardDescription>From log.md files (OKF §9).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {m.logs.map((l) => (
              <div key={l.path}>
                <p className="font-mono text-xs text-muted-foreground">{l.path}</p>
                {l.groups.map((g) => (
                  <div key={g.date} className="mt-2">
                    <p className="font-medium">{g.date}</p>
                    <ul className="ml-5 list-disc text-muted-foreground">
                      {g.entries.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Files</CardTitle>
          <CardDescription>Every file is stored content-addressed; SHA-256 shown.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Path</TH>
                <TH>Kind</TH>
                <TH>Size</TH>
                <TH>SHA-256</TH>
              </TR>
            </THead>
            <TBody>
              {files.data?.data.map((f) => (
                <TR key={f.path}>
                  <TD className="font-mono text-xs">{f.path}</TD>
                  <TD className="text-xs">{f.kind}</TD>
                  <TD className="tabular-nums text-xs">{formatBytes(f.size)}</TD>
                  <TD className="font-mono text-xs text-muted-foreground">{f.sha256.slice(0, 16)}…</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Raw profile</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(q.data!.profile, null, 2)}</pre>
        </CardContent>
      </Card>
    </div>
  );
}

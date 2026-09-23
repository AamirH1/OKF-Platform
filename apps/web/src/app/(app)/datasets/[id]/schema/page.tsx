'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/common';
import { useDataset } from '@/components/dataset-context';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { pct } from '@/lib/utils';

interface SchemaResponse {
  version: number;
  fields: { name: string; family: string; specDefined: boolean; specRequired: boolean; kinds: string[]; presentPct: number }[];
  assetSchemas: { conceptId: string; title: string; type: string; columns: { ordinal: number; name: string; dataType: string | null; mode: string | null; description: string | null }[] }[];
}

export default function SchemaPage() {
  const { dataset: d, versionParam, versionQs } = useDataset();
  const [filter, setFilter] = React.useState('');
  const q = useQuery({ queryKey: ['schema', d.id, versionParam], queryFn: () => api<SchemaResponse>(`/datasets/${d.id}/schema`, { query: { version: versionParam } }) });
  if (q.isLoading) return <LoadingRows />;
  if (q.error) return <ErrorState error={q.error} />;
  const s = q.data!;
  const f = filter.toLowerCase();
  const assets = s.assetSchemas.filter((a) => !f || a.conceptId.toLowerCase().includes(f) || a.title.toLowerCase().includes(f) || a.columns.some((c) => c.name.toLowerCase().includes(f)));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Frontmatter field schema</CardTitle>
          <CardDescription>
            Inferred by the platform across all concepts of v{s.version}. OKF requires only <code>type</code>; other fields are recommended, optional families, or producer extensions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Field</TH>
                <TH>Family</TH>
                <TH>Observed types</TH>
                <TH>Present in</TH>
              </TR>
            </THead>
            <TBody>
              {s.fields.map((field) => (
                <TR key={field.name}>
                  <TD className="font-mono text-xs">
                    {field.name} {field.specRequired ? <Badge tone="primary">required</Badge> : null}
                  </TD>
                  <TD>
                    <Badge tone={field.specDefined ? 'info' : 'outline'}>{field.family}</Badge>
                  </TD>
                  <TD className="text-xs text-muted-foreground">{field.kinds.join(', ')}</TD>
                  <TD className="tabular-nums">{pct(field.presentPct)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Asset schemas</CardTitle>
          <CardDescription>
            Columns documented under <code># Schema</code> headings (OKF §4.2) — the producer&apos;s description of the assets the concepts describe, parsed from tables or lists. Types are shown as written; they are documentation, not enforced.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input placeholder="Filter by concept or column name…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter schemas" className="max-w-sm" />
          {assets.length === 0 ? (
            <EmptyState title="No schemas found" description="No concept in this version has a parseable # Schema section." />
          ) : (
            assets.map((a) => (
              <div key={a.conceptId} className="rounded-lg border">
                <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
                  <Link href={`/datasets/${d.id}/concepts/${a.conceptId}${versionQs}`} className="font-medium text-primary hover:underline">
                    {a.title}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {a.type} · {a.columns.length} columns
                  </span>
                </div>
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-10">#</TH>
                      <TH>Column</TH>
                      <TH>Type</TH>
                      <TH>Mode</TH>
                      <TH>Description</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {a.columns.map((c) => (
                      <TR key={c.ordinal}>
                        <TD className="text-muted-foreground">{c.ordinal}</TD>
                        <TD className="font-mono text-xs">{c.name}</TD>
                        <TD className="font-mono text-xs">{c.dataType ?? '—'}</TD>
                        <TD className="text-xs">{c.mode ?? ''}</TD>
                        <TD className="text-sm text-muted-foreground">{c.description}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

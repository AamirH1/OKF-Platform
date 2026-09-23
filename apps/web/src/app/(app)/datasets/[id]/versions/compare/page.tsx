'use client';

import type { JobDTO } from '@okf/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Minus, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';
import { EmptyState, ErrorState, LoadingRows, Stat } from '@/components/common';
import { useDataset } from '@/components/dataset-context';
import { JobProgress } from '@/components/upload';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { api } from '@/lib/api';

interface Diff {
  exact: {
    concepts: {
      added: { id: string; type: string; title: string }[];
      removed: { id: string; type: string; title: string }[];
      modified: { id: string; title: string; bodyChanged: boolean; typeChanged: { before: string; after: string } | null; frontmatterChanges: { key: string; change: string; before?: unknown; after?: unknown }[] }[];
      unchangedCount: number;
    };
    assetSchemas: { conceptId: string; status: string; addedColumns: { name: string; dataType: string | null }[]; removedColumns: { name: string; dataType: string | null }[]; typeChanges: { name: string; before: string | null; after: string | null }[] }[];
    fieldSchema: { addedFields: string[]; removedFields: string[]; kindChanges: { field: string; before: string[]; after: string[] }[] };
  };
  statistical: {
    conceptCount: { before: number; after: number; delta: number };
    totalBytes: { before: number; after: number; delta: number };
    staleCount: { before: number; after: number; delta: number };
    brokenLinks: { before: number; after: number; delta: number };
    qualityScore: { before: number; after: number; delta: number };
    types: { value: string; before: number; after: number; delta: number }[];
    trustTiers: { tier: string; before: number; after: number; delta: number }[];
    fieldPresence: { field: string; beforePct: number; afterPct: number; deltaPct: number }[];
  };
  summary: { added: number; removed: number; modified: number; unchanged: number; schemaChanges: number; breaking: boolean };
}

const fmt = (v: unknown) => (v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify(v));
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export default function ComparePage() {
  const { dataset: d } = useDataset();
  const params = useSearchParams();
  const base = params.get('base');
  const target = params.get('target');
  const [jobId, setJobId] = React.useState<string | null>(null);
  const q = useQuery({
    queryKey: ['diff', d.id, base, target],
    enabled: !!base && !!target,
    queryFn: async () => {
      const r = await api<{ diff?: Diff; job?: JobDTO }>(`/datasets/${d.id}/diff`, { query: { base, target } });
      if (r.job) setJobId(r.job.id);
      return r;
    },
  });
  if (!base || !target) return <EmptyState title="Choose two versions to compare" action={<Link href={`/datasets/${d.id}/versions`} className="text-primary">Back to versions</Link>} />;
  if (q.isLoading) return <LoadingRows />;
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data?.diff) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Comparing v{base} → v{target}</CardTitle>
          <CardDescription>The comparison runs in the background.</CardDescription>
        </CardHeader>
        <CardContent>{jobId ? <JobProgress jobId={jobId} onDone={() => void q.refetch()} /> : null}</CardContent>
      </Card>
    );
  }
  const diff = q.data.diff;
  const s = diff.statistical;
  return (
    <div className="space-y-6">
      <Link href={`/datasets/${d.id}/versions`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Versions
      </Link>
      <h2 className="text-xl font-semibold">
        v{base} → v{target}
      </h2>
      {diff.summary.breaking ? (
        <Alert tone="warning" title="Potentially breaking changes">
          Concepts were removed, a concept changed type, or documented columns were removed or retyped.
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Added" value={diff.summary.added} />
        <Stat label="Removed" value={diff.summary.removed} />
        <Stat label="Modified" value={diff.summary.modified} />
        <Stat label="Unchanged" value={diff.summary.unchanged} />
        <Stat label="Schema changes" value={diff.summary.schemaChanges} />
      </div>

      <section className="space-y-4">
        <div>
          <h3 className="font-semibold">Exact comparison</h3>
          <p className="text-sm text-muted-foreground">Computed from every concept in both versions (file hashes, frontmatter values, parsed schema columns). Concepts are matched by path, so a renamed file appears as removed + added.</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Concepts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {diff.exact.concepts.added.map((c) => (
              <p key={c.id} className="flex items-center gap-2">
                <Plus className="size-4 text-success" /> <span className="font-mono text-xs">{c.id}</span> <span className="text-muted-foreground">{c.type}</span>
              </p>
            ))}
            {diff.exact.concepts.removed.map((c) => (
              <p key={c.id} className="flex items-center gap-2">
                <Minus className="size-4 text-destructive" /> <span className="font-mono text-xs">{c.id}</span> <span className="text-muted-foreground">{c.type}</span>
              </p>
            ))}
            {diff.exact.concepts.modified.map((c) => (
              <div key={c.id}>
                <p className="flex items-center gap-2">
                  <Pencil className="size-4 text-info" /> <span className="font-mono text-xs">{c.id}</span>
                  {c.bodyChanged ? <Badge tone="outline">body changed</Badge> : null}
                  {c.typeChanged ? <Badge tone="warning">type {c.typeChanged.before} → {c.typeChanged.after}</Badge> : null}
                </p>
                {c.frontmatterChanges.length ? (
                  <ul className="ml-6 mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {c.frontmatterChanges.map((f) => (
                      <li key={f.key}>
                        <span className="font-mono">{f.key}</span> {f.change}: <span className="line-through">{fmt(f.before)}</span> → <span className="text-foreground">{fmt(f.after)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
            {diff.summary.added + diff.summary.removed + diff.summary.modified === 0 ? <p className="text-muted-foreground">No concept changes.</p> : null}
          </CardContent>
        </Card>
        {diff.exact.assetSchemas.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Asset schema changes</CardTitle>
              <CardDescription>From `# Schema` sections.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {diff.exact.assetSchemas.map((a) => (
                <div key={a.conceptId}>
                  <p className="font-mono text-xs">
                    {a.conceptId} <Badge tone="outline">{a.status}</Badge>
                  </p>
                  <ul className="ml-4 mt-1 space-y-0.5 text-xs">
                    {a.addedColumns.map((c) => (
                      <li key={`+${c.name}`} className="text-success">
                        + {c.name} {c.dataType}
                      </li>
                    ))}
                    {a.removedColumns.map((c) => (
                      <li key={`-${c.name}`} className="text-destructive">
                        − {c.name} {c.dataType}
                      </li>
                    ))}
                    {a.typeChanges.map((c) => (
                      <li key={`~${c.name}`} className="text-warning">
                        ~ {c.name}: {c.before} → {c.after}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}
        {diff.exact.fieldSchema.addedFields.length + diff.exact.fieldSchema.removedFields.length + diff.exact.fieldSchema.kindChanges.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Frontmatter field schema</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {diff.exact.fieldSchema.addedFields.length ? <p>Added: {diff.exact.fieldSchema.addedFields.join(', ')}</p> : null}
              {diff.exact.fieldSchema.removedFields.length ? <p>Removed: {diff.exact.fieldSchema.removedFields.join(', ')}</p> : null}
              {diff.exact.fieldSchema.kindChanges.map((k) => (
                <p key={k.field}>
                  {k.field}: {k.before.join('/')} → {k.after.join('/')}
                </p>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="font-semibold">Aggregate statistics</h3>
          <p className="text-sm text-muted-foreground">Deltas between whole-version summary metrics. Each value is exact for its version, but deltas describe distributions, not individual concepts — opposite changes can cancel out.</p>
        </div>
        <Card>
          <CardContent className="pt-5">
            <Table>
              <THead>
                <TR>
                  <TH>Metric</TH>
                  <TH>v{base}</TH>
                  <TH>v{target}</TH>
                  <TH>Δ</TH>
                </TR>
              </THead>
              <TBody>
                {(
                  [
                    ['Concepts', s.conceptCount],
                    ['Total bytes', s.totalBytes],
                    ['Stale concepts', s.staleCount],
                    ['Broken links', s.brokenLinks],
                    ['Quality score', s.qualityScore],
                  ] as const
                ).map(([label, m]) => (
                  <TR key={label}>
                    <TD>{label}</TD>
                    <TD className="tabular-nums">{m.before}</TD>
                    <TD className="tabular-nums">{m.after}</TD>
                    <TD className="tabular-nums">{signed(m.delta)}</TD>
                  </TR>
                ))}
                {s.types.map((t) => (
                  <TR key={`type-${t.value}`}>
                    <TD>type = {t.value}</TD>
                    <TD className="tabular-nums">{t.before}</TD>
                    <TD className="tabular-nums">{t.after}</TD>
                    <TD className="tabular-nums">{signed(t.delta)}</TD>
                  </TR>
                ))}
                {s.trustTiers.map((t) => (
                  <TR key={`tier-${t.tier}`}>
                    <TD>{t.tier}</TD>
                    <TD className="tabular-nums">{t.before}</TD>
                    <TD className="tabular-nums">{t.after}</TD>
                    <TD className="tabular-nums">{signed(t.delta)}</TD>
                  </TR>
                ))}
                {s.fieldPresence.map((f) => (
                  <TR key={`field-${f.field}`}>
                    <TD>
                      <span className="font-mono text-xs">{f.field}</span> present
                    </TD>
                    <TD className="tabular-nums">{f.beforePct}%</TD>
                    <TD className="tabular-nums">{f.afterPct}%</TD>
                    <TD className="tabular-nums">{signed(f.deltaPct)} pp</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

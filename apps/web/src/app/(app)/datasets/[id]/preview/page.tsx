'use client';

import type { ConceptSummaryDTO, Page } from '@okf/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { ErrorState, LoadingRows, Pagination, Stat, TrustBadge } from '@/components/common';
import { useDataset } from '@/components/dataset-context';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Select, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { formatBytes, formatNumber, pct } from '@/lib/utils';

interface FieldProfile {
  name: string;
  family: string;
  specDefined: boolean;
  kinds: string[];
  presentPct: number;
  nullPct: number;
  distinctCount: number;
  distinctCapped: boolean;
  topValues: { value: string; count: number }[];
  min: string | number | null;
  max: string | number | null;
}

interface PreviewResponse {
  version: number;
  rowCount: number | null;
  fileCount: number | null;
  totalBytes: number | null;
  columns: FieldProfile[];
  rows: Page<ConceptSummaryDTO>;
}

export default function PreviewPage() {
  const { dataset: d, versionParam, versionQs } = useDataset();
  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [type, setType] = React.useState('');
  const [trustTier, setTrustTier] = React.useState('');
  const [sort, setSort] = React.useState('concept_id');
  const [page, setPage] = React.useState(1);
  React.useEffect(() => {
    const t = setTimeout(() => (setDebounced(search), setPage(1)), 300);
    return () => clearTimeout(t);
  }, [search]);
  const query = { version: versionParam, search: debounced, type, trustTier, sort, page, pageSize: 25 };
  const q = useQuery({
    queryKey: ['preview', d.id, query],
    queryFn: () => api<PreviewResponse>(`/datasets/${d.id}/preview`, { query }),
    placeholderData: keepPreviousData,
  });
  if (q.isLoading) return <LoadingRows />;
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const r = q.data!;
  const typeValues = r.columns.find((c) => c.name === 'type')?.topValues ?? [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Rows (concepts)" value={formatNumber(r.rowCount)} />
        <Stat label="Columns (fields)" value={r.columns.length} />
        <Stat label="Files" value={formatNumber(r.fileCount)} />
        <Stat label="Size" value={formatBytes(r.totalBytes)} />
      </div>
      <Alert tone="info">
        OKF bundles contain knowledge documents, not tabular data. Each row is a concept; columns are its frontmatter fields. Statistics are exact, computed over every concept of v{r.version}.
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Field statistics</CardTitle>
          <CardDescription>Null % counts concepts where the field is absent or null.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table data-testid="field-stats">
            <THead>
              <TR>
                <TH>Field</TH>
                <TH>Types</TH>
                <TH>Null %</TH>
                <TH>Distinct</TH>
                <TH>Min</TH>
                <TH>Max</TH>
                <TH>Top values</TH>
              </TR>
            </THead>
            <TBody>
              {r.columns.map((c) => (
                <TR key={c.name}>
                  <TD className="font-mono text-xs">
                    {c.name}
                    {c.specDefined ? null : (
                      <Badge tone="outline" className="ml-1.5">
                        extension
                      </Badge>
                    )}
                  </TD>
                  <TD className="text-xs text-muted-foreground">{c.kinds.join(', ')}</TD>
                  <TD className="tabular-nums">{pct(c.nullPct)}</TD>
                  <TD className="tabular-nums">
                    {formatNumber(c.distinctCount)}
                    {c.distinctCapped ? '+' : ''}
                  </TD>
                  <TD className="max-w-32 truncate text-xs">{c.min ?? '—'}</TD>
                  <TD className="max-w-32 truncate text-xs">{c.max ?? '—'}</TD>
                  <TD className="max-w-md text-xs text-muted-foreground">
                    <span className="line-clamp-2">{c.topValues.slice(0, 4).map((t) => `${t.value} (${t.count})`).join(' · ') || '—'}</span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Concepts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            <Input placeholder="Search title, id or text…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search concepts" className="sm:max-w-xs" />
            <Select value={type} onChange={(e) => (setType(e.target.value), setPage(1))} aria-label="Type" className="sm:w-48">
              <option value="">All types</option>
              {typeValues.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.value} ({t.count})
                </option>
              ))}
            </Select>
            <Select value={trustTier} onChange={(e) => (setTrustTier(e.target.value), setPage(1))} aria-label="Trust tier" className="sm:w-48">
              <option value="">Any trust tier</option>
              <option value="human-reviewed">human-reviewed</option>
              <option value="machine-confirmed">machine-confirmed</option>
              <option value="unverified">unverified</option>
            </Select>
            <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort" className="sm:w-40">
              <option value="concept_id">Concept ID</option>
              <option value="title">Title</option>
              <option value="type">Type</option>
              <option value="words">Longest</option>
              <option value="links">Most links</option>
            </Select>
          </div>
          <Table data-testid="concept-table">
            <THead>
              <TR>
                <TH>Concept</TH>
                <TH>Type</TH>
                <TH>Trust</TH>
                <TH>Status</TH>
                <TH>Links</TH>
                <TH>Schema cols</TH>
              </TR>
            </THead>
            <TBody>
              {r.rows.data.map((c) => (
                <TR key={c.conceptId}>
                  <TD>
                    <Link href={`/datasets/${d.id}/concepts/${c.conceptId.split('/').map(encodeURIComponent).join('/')}${versionQs}`} className="font-medium text-primary hover:underline">
                      {c.title}
                    </Link>
                    <p className="font-mono text-xs text-muted-foreground">{c.conceptId}</p>
                    {c.description ? <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{c.description}</p> : null}
                  </TD>
                  <TD className="text-sm">{c.type}</TD>
                  <TD>
                    <TrustBadge tier={c.trustTier} />
                  </TD>
                  <TD className="text-sm">
                    {c.status}
                    {c.isStale ? (
                      <Badge tone="warning" className="ml-1">
                        stale
                      </Badge>
                    ) : null}
                  </TD>
                  <TD className="tabular-nums text-sm">
                    {c.linkCount}
                    {c.brokenLinkCount ? <span className="text-warning"> ({c.brokenLinkCount} broken)</span> : null}
                  </TD>
                  <TD className="tabular-nums text-sm">{c.schemaColumnCount || '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={25} total={r.rows.page.total} onPage={setPage} />
        </CardContent>
      </Card>
    </div>
  );
}

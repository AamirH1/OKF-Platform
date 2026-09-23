'use client';

import { FILTER_OPS, type QueryResultDTO } from '@okf/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, Play, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { ErrorState, LoadingRows, Pagination } from '@/components/common';
import { useDataset } from '@/components/dataset-context';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Select, Table, TBody, TD, Textarea, TH, THead, TR } from '@/components/ui/primitives';
import { api, ApiError } from '@/lib/api';

interface TableDef {
  name: string;
  columns: { name: string; kind: string; description: string }[];
}
interface Filter {
  column: string;
  op: (typeof FILTER_OPS)[number];
  value: string;
}

const EXAMPLES = [
  { label: 'Concepts per type', sql: 'SELECT type, count(*) AS concepts\nFROM concepts\nGROUP BY type\nORDER BY concepts DESC' },
  { label: 'Broken links', sql: "SELECT source_concept_id, raw, via, line\nFROM links\nWHERE broken\nORDER BY source_concept_id" },
  { label: 'Columns by name', sql: "SELECT concept_id, name, data_type\nFROM schema_columns\nWHERE name ILIKE '%id%'\nORDER BY concept_id, ordinal" },
  { label: 'Unverified & stale', sql: "SELECT concept_id, title, stale_after\nFROM concepts\nWHERE trust_tier = 'unverified' OR is_stale\nORDER BY concept_id" },
  { label: 'Frontmatter JSON', sql: "SELECT concept_id, json_extract_string(frontmatter_json, '$.status') AS status\nFROM concepts\nLIMIT 50" },
];

function toCsv(result: QueryResultDTO): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Prefix formula-like cells so spreadsheets do not evaluate them (CSV injection).
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [result.columns.map((c) => esc(c.name)).join(','), ...result.rows.map((r) => result.columns.map((c) => esc(r[c.name])).join(','))].join('\n');
}

function ResultTable({ result }: { result: QueryResultDTO }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(result)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'query-results.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-2" data-testid="query-results">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {result.rows.length} rows{result.total !== null ? ` of ${result.total}` : ''} · {result.elapsedMs} ms · {result.engine} · v{result.version}
        </span>
        <Button variant="ghost" size="sm" onClick={download} disabled={result.rows.length === 0}>
          <Download /> CSV
        </Button>
      </div>
      {result.truncated ? <Alert tone="warning">Results were truncated at the row limit. Add a LIMIT or narrower filters.</Alert> : null}
      <Table>
        <THead>
          <TR>
            {result.columns.map((c) => (
              <TH key={c.name} title={c.type}>
                {c.name}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {result.rows.map((r, i) => (
            <TR key={i}>
              {result.columns.map((c) => {
                const v = r[c.name];
                return (
                  <TD key={c.name} className="max-w-md truncate font-mono text-xs" title={typeof v === 'string' ? v : JSON.stringify(v)}>
                    {v === null ? <span className="text-muted-foreground">null</span> : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                  </TD>
                );
              })}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function QueryError({ error }: { error: unknown }) {
  const e = error instanceof ApiError ? error : null;
  return (
    <Alert tone="danger" title={e?.code === 'QUERY_TIMEOUT' ? 'Query timed out' : 'Query failed'}>
      {e?.message ?? 'Unexpected error'}
    </Alert>
  );
}

export default function QueryPage() {
  const { dataset: d, versionParam } = useDataset();
  const tables = useQuery({ queryKey: ['query-tables', d.id], queryFn: () => api<{ tables: TableDef[] }>(`/datasets/${d.id}/query/tables`) });
  const [table, setTable] = React.useState('concepts');
  const [columns, setColumns] = React.useState<string[]>([]);
  const [filters, setFilters] = React.useState<Filter[]>([]);
  const [search, setSearch] = React.useState('');
  const [sortCol, setSortCol] = React.useState('');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('asc');
  const [page, setPage] = React.useState(1);
  const [sql, setSql] = React.useState(EXAMPLES[0]!.sql);

  const def = tables.data?.tables.find((t) => t.name === table);
  const structured = useMutation({
    mutationFn: (p: number) =>
      api<QueryResultDTO>(`/datasets/${d.id}/query`, {
        method: 'POST',
        body: {
          version: versionParam,
          table,
          columns: columns.length ? columns : undefined,
          filters: filters.map((f) => ({
            column: f.column,
            op: f.op,
            value: f.op === 'in' ? f.value.split(',').map((s) => s.trim()) : f.op === 'is_null' || f.op === 'is_not_null' ? undefined : f.value,
          })),
          search: search || undefined,
          sort: sortCol ? [{ column: sortCol, direction: sortDir }] : [],
          page: p,
          pageSize: 50,
        },
      }),
    onError: () => undefined,
  });
  const sqlRun = useMutation({
    mutationFn: () => api<QueryResultDTO>(`/datasets/${d.id}/query/sql`, { method: 'POST', body: { version: versionParam, sql, maxRows: 1000 } }),
    onError: () => undefined,
  });
  const run = (p = 1) => {
    setPage(p);
    structured.mutate(p);
  };

  if (!d.permissions.includes('dataset:query')) return <Alert tone="warning">You cannot query this dataset.</Alert>;
  if (tables.isLoading) return <LoadingRows />;
  if (tables.error) return <ErrorState error={tables.error} />;

  return (
    <Tabs defaultValue="builder" className="space-y-4">
      <TabsList>
        <TabsTrigger value="builder">Query builder</TabsTrigger>
        <TabsTrigger value="sql">SQL</TabsTrigger>
      </TabsList>
      <TabsContent value="builder" className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Build a query</CardTitle>
            <CardDescription>Select columns, filter, sort and paginate. Runs on DuckDB over this version&apos;s concept tables.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Select aria-label="Table" value={table} onChange={(e) => (setTable(e.target.value), setColumns([]), setFilters([]), setSortCol(''))} className="w-48">
                {tables.data!.tables.map((t) => (
                  <option key={t.name}>{t.name}</option>
                ))}
              </Select>
              <Input placeholder="Search text columns…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" className="w-64" />
              <Select aria-label="Sort by" value={sortCol} onChange={(e) => setSortCol(e.target.value)} className="w-48">
                <option value="">Default order</option>
                {def?.columns.filter((c) => c.kind !== 'string_list').map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
              </Select>
              <Select aria-label="Sort direction" value={sortDir} onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')} className="w-28">
                <option value="asc">asc</option>
                <option value="desc">desc</option>
              </Select>
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Columns {columns.length ? `(${columns.length})` : '(all)'}</legend>
              <div className="flex flex-wrap gap-1.5">
                {def?.columns.map((c) => {
                  const on = columns.includes(c.name);
                  return (
                    <button
                      key={c.name}
                      type="button"
                      title={c.description}
                      aria-pressed={on}
                      onClick={() => setColumns((cols) => (on ? cols.filter((x) => x !== c.name) : [...cols, c.name]))}
                      className={`rounded-full border px-2.5 py-0.5 font-mono text-xs ${on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="space-y-2">
              {filters.map((f, i) => (
                <div key={i} className="flex flex-wrap gap-2">
                  <Select aria-label="Filter column" value={f.column} onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))} className="w-48">
                    {def?.columns.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </Select>
                  <Select aria-label="Operator" value={f.op} onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, op: e.target.value as Filter['op'] } : x)))} className="w-36">
                    {FILTER_OPS.map((op) => (
                      <option key={op}>{op}</option>
                    ))}
                  </Select>
                  {f.op !== 'is_null' && f.op !== 'is_not_null' ? (
                    <Input aria-label="Value" value={f.value} placeholder={f.op === 'in' ? 'a, b, c' : 'value'} onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className="w-56" />
                  ) : null}
                  <Button variant="ghost" size="icon" aria-label="Remove filter" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setFilters((fs) => [...fs, { column: def?.columns[0]?.name ?? '', op: 'eq', value: '' }])}>
                  <Plus /> Filter
                </Button>
                <Button size="sm" onClick={() => run(1)} disabled={structured.isPending}>
                  <Play /> Run
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
        {structured.error ? <QueryError error={structured.error} /> : null}
        {structured.data ? (
          <Card>
            <CardContent className="pt-5">
              <ResultTable result={structured.data} />
              <Pagination page={page} pageSize={50} total={structured.data.total ?? 0} onPage={run} />
            </CardContent>
          </Card>
        ) : null}
      </TabsContent>
      <TabsContent value="sql" className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>SQL</CardTitle>
            <CardDescription>
              One read-only SELECT over <code>concepts</code>, <code>links</code> and <code>schema_columns</code> (DuckDB dialect). Sandboxed: no file or network access, row-limited, time-limited.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((e) => (
                <Button key={e.label} variant="outline" size="sm" onClick={() => setSql(e.sql)}>
                  {e.label}
                </Button>
              ))}
            </div>
            <Textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={8}
              className="font-mono text-xs"
              aria-label="SQL query"
              spellCheck={false}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sqlRun.mutate();
              }}
            />
            <Button onClick={() => sqlRun.mutate()} disabled={sqlRun.isPending || !sql.trim()}>
              <Play /> Run <span className="text-xs opacity-70">⌘↵</span>
            </Button>
          </CardContent>
        </Card>
        {sqlRun.error ? <QueryError error={sqlRun.error} /> : null}
        {sqlRun.data ? (
          <Card>
            <CardContent className="pt-5">
              <ResultTable result={sqlRun.data} />
            </CardContent>
          </Card>
        ) : null}
      </TabsContent>
    </Tabs>
  );
}

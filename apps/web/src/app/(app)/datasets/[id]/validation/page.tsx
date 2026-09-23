'use client';

import type { ValidationReportDTO } from '@okf/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import * as React from 'react';
import { ErrorState, LoadingRows, Pagination, Stat } from '@/components/common';
import { useDataset } from '@/components/dataset-context';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Select, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const SEVERITY_ICON = { error: XCircle, warning: AlertTriangle, info: Info } as const;
const SEVERITY_CLASS = { error: 'text-destructive', warning: 'text-warning', info: 'text-info' } as const;

export default function ValidationPage() {
  const { dataset: d, versionParam } = useDataset();
  const [severity, setSeverity] = React.useState('');
  const [layer, setLayer] = React.useState('');
  const [code, setCode] = React.useState('');
  const [page, setPage] = React.useState(1);
  const query = { version: versionParam, severity, layer, code, page, pageSize: 50 };
  const q = useQuery({
    queryKey: ['validation', d.id, query],
    queryFn: () => api<ValidationReportDTO>(`/datasets/${d.id}/validation`, { query }),
    placeholderData: keepPreviousData,
  });
  if (q.isLoading) return <LoadingRows />;
  if (q.error) return <ErrorState error={q.error} />;
  const r = q.data!;
  const structural = r.byCode.filter((b) => b.layer === 'structural');
  const quality = r.byCode.filter((b) => b.layer === 'quality');

  return (
    <div className="space-y-6">
      {r.valid === null ? (
        <Alert tone={r.failure ? 'danger' : 'info'} title={r.failure ? 'Processing failed before validation' : 'Not validated yet'}>
          {r.failure ? `${r.failure.message} (${r.failure.code})` : 'This version is still processing.'}
        </Alert>
      ) : (
        <div className={cn('flex items-start gap-3 rounded-lg border p-4', r.valid ? 'border-success/40 bg-success/8' : 'border-destructive/40 bg-destructive/8')} data-testid="validation-verdict">
          {r.valid ? <CheckCircle2 className="mt-0.5 size-5 text-success" /> : <AlertCircle className="mt-0.5 size-5 text-destructive" />}
          <div>
            <p className="font-medium">{r.valid ? `v${r.version} is OKF v${r.specVersion} conformant` : `v${r.version} is not OKF-conformant`}</p>
            <p className="text-sm text-muted-foreground">
              {r.valid
                ? 'No structural errors. Quality findings below never affect conformance.'
                : `${r.counts.errors} structural error(s) under OKF §11. Non-conformant versions cannot be published.`}{' '}
              Validator {r.validatorVersion}.
            </p>
          </div>
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Errors" value={r.counts.errors} hint="Structural (OKF §11)" />
        <Stat label="Warnings" value={r.counts.warnings} hint="Quality checks" />
        <Stat label="Info" value={r.counts.infos} hint="Quality checks" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {[
          { title: 'OKF structural conformance', desc: 'Only these rules decide validity: parseable frontmatter, non-empty type, reserved-file structure.', items: structural },
          { title: 'Platform quality checks', desc: 'Helpful findings (missing descriptions, broken links, staleness…). The spec forbids rejecting bundles for these.', items: quality },
        ].map((g) => (
          <Card key={g.title}>
            <CardHeader>
              <CardTitle>{g.title}</CardTitle>
              <CardDescription>{g.desc}</CardDescription>
            </CardHeader>
            <CardContent>
              {g.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">No findings.</p>
              ) : (
                <ul className="space-y-1">
                  {g.items.map((b) => (
                    <li key={b.code}>
                      <button className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-muted" onClick={() => (setCode(b.code), setPage(1))}>
                        <span className="font-mono text-xs">{b.code}</span>
                        <Badge tone={b.severity === 'error' ? 'danger' : b.severity === 'warning' ? 'warning' : 'info'}>
                          {b.count}
                          {r.suppressed[b.code] ? `+${r.suppressed[b.code]}` : ''}
                        </Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Issues</CardTitle>
          {Object.keys(r.suppressed).length ? <CardDescription>Some repetitive quality findings were capped per code; totals include them.</CardDescription> : null}
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap gap-2">
            <Select value={severity} onChange={(e) => (setSeverity(e.target.value), setPage(1))} aria-label="Severity" className="w-36">
              <option value="">All severities</option>
              <option value="error">Errors</option>
              <option value="warning">Warnings</option>
              <option value="info">Info</option>
            </Select>
            <Select value={layer} onChange={(e) => (setLayer(e.target.value), setPage(1))} aria-label="Layer" className="w-40">
              <option value="">All layers</option>
              <option value="structural">Structural</option>
              <option value="quality">Quality</option>
            </Select>
            {code ? (
              <button className="rounded-md border px-2 text-sm" onClick={() => setCode('')}>
                {code} ✕
              </button>
            ) : null}
          </div>
          <Table data-testid="validation-issues">
            <THead>
              <TR>
                <TH className="w-8" />
                <TH>Location</TH>
                <TH>Message</TH>
                <TH>Code</TH>
              </TR>
            </THead>
            <TBody>
              {r.issues.data.map((i, idx) => {
                const Icon = SEVERITY_ICON[i.severity];
                return (
                  <TR key={idx}>
                    <TD>
                      <Icon className={cn('size-4', SEVERITY_CLASS[i.severity])} aria-label={i.severity} />
                    </TD>
                    <TD className="font-mono text-xs whitespace-nowrap">
                      {i.location.path || '(bundle)'}
                      {i.location.line ? `:${i.location.line}` : ''}
                      {i.field ? <span className="block text-muted-foreground">{i.field}</span> : null}
                    </TD>
                    <TD className="text-sm">{i.message}</TD>
                    <TD>
                      <Badge tone={i.layer === 'structural' ? 'danger' : 'outline'}>{i.code}</Badge>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={50} total={r.issues.page.total} onPage={setPage} />
        </CardContent>
      </Card>
    </div>
  );
}

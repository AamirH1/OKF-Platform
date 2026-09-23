'use client';

import type { AuditLogDTO } from '@okf/shared';
import { EmptyState } from '@/components/common';
import { Badge, Table, TBody, TD, TH, THead, TR } from '@/components/ui/primitives';
import { formatDate } from '@/lib/utils';

function summarize(e: AuditLogDTO): string {
  const m = e.metadata;
  const parts: string[] = [];
  for (const k of ['version', 'name', 'filename', 'role', 'from', 'to', 'email', 'prefix', 'code', 'errors', 'warnings', 'concepts']) {
    if (m[k] !== undefined && m[k] !== null) parts.push(`${k}: ${typeof m[k] === 'object' ? JSON.stringify(m[k]) : String(m[k])}`);
  }
  if (typeof m.sql === 'string') parts.push(`sql: ${m.sql.slice(0, 80)}${m.sql.length > 80 ? '…' : ''}`);
  return parts.join(' · ');
}

export function AuditTable({ entries }: { entries: AuditLogDTO[] }) {
  if (entries.length === 0) return <EmptyState title="No activity yet" />;
  return (
    <Table data-testid="audit-table">
      <THead>
        <TR>
          <TH>When</TH>
          <TH>Action</TH>
          <TH>Actor</TH>
          <TH>Details</TH>
          <TH>IP</TH>
        </TR>
      </THead>
      <TBody>
        {entries.map((e) => (
          <TR key={e.id}>
            <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(e.createdAt)}</TD>
            <TD>
              <Badge tone={e.action.includes('failed') || e.action.includes('deleted') || e.action.includes('revoked') ? 'danger' : 'default'}>{e.action}</Badge>
            </TD>
            <TD className="text-sm">
              {e.actor?.name ?? (e.actorType === 'system' ? 'System' : e.actorType)}
              {e.actorType === 'api_key' ? <Badge tone="outline" className="ml-1">API key</Badge> : null}
            </TD>
            <TD className="max-w-md text-xs text-muted-foreground">
              <span className="line-clamp-2">{summarize(e)}</span>
            </TD>
            <TD className="font-mono text-xs text-muted-foreground">{e.ip ?? '—'}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

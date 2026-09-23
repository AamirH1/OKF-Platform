'use client';

import type { DatasetDTO } from '@okf/shared';
import { Database } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge, VisibilityBadge } from '@/components/common';
import { Badge } from '@/components/ui/primitives';
import { formatNumber, timeAgo } from '@/lib/utils';

export function DatasetList({ datasets }: { datasets: DatasetDTO[] }) {
  return (
    <ul className="okf-stagger space-y-2" data-testid="dataset-list">
      {datasets.map((d) => {
        const v = d.latestVersion ?? d.publishedVersion;
        return (
          <li key={d.id}>
            <Link href={`/datasets/${d.id}`} className="okf-lift flex items-start gap-3 rounded-lg border bg-card px-4 py-3">
              <Database className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.name}</span>
                  <StatusBadge status={d.status} />
                  <VisibilityBadge visibility={d.visibility} />
                </div>
                {d.description ? <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{d.description}</p> : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{d.organization.name}</span>
                  {v ? <span>v{v.number} · {formatNumber(v.conceptCount)} concepts</span> : <span>No versions</span>}
                  <span>Updated {timeAgo(d.updatedAt)}</span>
                  {d.tags.slice(0, 4).map((t) => (
                    <Badge key={t} tone="outline">
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

'use client';

import type { Page, SearchHitDTO } from '@okf/shared';
import { Database, FileText } from 'lucide-react';
import Link from 'next/link';
import { Highlighted, StatusBadge, VisibilityBadge } from '@/components/common';
import { Badge } from '@/components/ui/primitives';
import { timeAgo } from '@/lib/utils';

export function SearchResults({ results }: { results: Page<SearchHitDTO> }) {
  return (
    <ul className="divide-y rounded-lg border" data-testid="search-results">
      {results.data.map((h, i) => {
        const href = h.concept ? `/datasets/${h.dataset.id}/concepts/${h.concept.conceptId.split('/').map(encodeURIComponent).join('/')}` : `/datasets/${h.dataset.id}`;
        return (
          <li key={`${h.dataset.id}-${h.concept?.conceptId ?? ''}-${i}`}>
            <Link href={href} className="flex gap-3 px-4 py-3 hover:bg-muted/40">
              {h.concept ? <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <Database className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{h.concept ? h.concept.title : h.dataset.name}</span>
                  {h.concept ? <Badge tone="primary">{h.concept.type}</Badge> : <StatusBadge status={h.dataset.status} />}
                  <VisibilityBadge visibility={h.dataset.visibility} />
                </div>
                {h.snippet ? (
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    <Highlighted text={h.snippet} />
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  {h.concept ? `${h.dataset.name} · ` : ''}
                  {h.dataset.organization.name} · updated {timeAgo(h.updatedAt)}
                  {h.tags.length ? ` · ${h.tags.slice(0, 5).join(', ')}` : ''}
                </p>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

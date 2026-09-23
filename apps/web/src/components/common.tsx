'use client';

import type { DatasetStatus, VersionStatus } from '@okf/shared';
import { AlertTriangle, ChevronLeft, ChevronRight, FileQuestion, Globe, Lock, Users } from 'lucide-react';
import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeTone, Skeleton } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';

export function PageHeader({ title, description, actions, eyebrow }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; eyebrow?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 text-sm text-muted-foreground">{eyebrow}</div> : null}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

const STATUS_TONE: Record<DatasetStatus | VersionStatus, BadgeTone> = {
  DRAFT: 'outline',
  PROCESSING: 'info',
  VALIDATED: 'primary',
  PUBLISHED: 'success',
  ARCHIVED: 'default',
  FAILED: 'danger',
};

export function StatusBadge({ status }: { status: DatasetStatus | VersionStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} data-testid="status-badge">
      {status === 'PROCESSING' ? <span className="size-1.5 animate-pulse rounded-full bg-current" /> : null}
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </Badge>
  );
}

export function VisibilityBadge({ visibility }: { visibility: 'private' | 'organization' | 'public' }) {
  const Icon = visibility === 'public' ? Globe : visibility === 'private' ? Lock : Users;
  return (
    <Badge tone="outline">
      <Icon className="size-3" />
      {visibility === 'organization' ? 'Organization' : visibility.charAt(0).toUpperCase() + visibility.slice(1)}
    </Badge>
  );
}

export function TrustBadge({ tier }: { tier: string }) {
  const tone: BadgeTone = tier === 'human-reviewed' ? 'success' : tier === 'machine-confirmed' ? 'info' : 'outline';
  return <Badge tone={tone}>{tier}</Badge>;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const e = error instanceof ApiError ? error : null;
  const notFound = e?.status === 404;
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center" role="alert">
      {notFound ? <FileQuestion className="size-8 text-muted-foreground" /> : <AlertTriangle className="size-8 text-destructive" />}
      <h2 className="mt-3 font-medium">{notFound ? 'Not found' : e?.status === 403 ? 'Access denied' : 'Something went wrong'}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{notFound ? 'It does not exist, or you do not have access to it.' : (e?.message ?? 'An unexpected error occurred.')}</p>
      {e?.requestId ? <p className="mt-2 font-mono text-xs text-muted-foreground">Request ID: {e.requestId}</p> : null}
      {retry && !notFound ? (
        <Button variant="outline" size="sm" className="mt-4" onClick={retry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ icon: Icon = FileQuestion, title, description, action }: { icon?: React.ComponentType<{ className?: string }>; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center">
      <Icon className="size-8 text-muted-foreground" />
      <h2 className="mt-3 font-medium">{title}</h2>
      {description ? <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 pt-3 text-sm text-muted-foreground">
      <span>
        {(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="px-2">
          Page {page} of {pages}
        </span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

/**
 * Render untrusted concept markdown. react-markdown builds React elements and ignores raw
 * HTML, so uploaded content cannot inject script. Links open with rel=noopener; in-bundle
 * links are rewritten by `resolveHref`.
 */
export function Markdown({ children, resolveHref }: { children: string; resolveHref?: (href: string) => string | null }) {
  return (
    <div className="prose-okf">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        // Allow only http(s)/mailto and scheme-less (relative/anchor) URLs; drop javascript:, data:, etc.
        urlTransform={(url) => (/^(https?:|mailto:)/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url : '')}
        components={{
          a: ({ href, children: c }) => {
            const internal = href && resolveHref ? resolveHref(href) : null;
            if (internal) return <a href={internal}>{c}</a>;
            return (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {c}
              </a>
            );
          },
          img: ({ alt }) => <span className="text-muted-foreground">[image: {alt}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Render a search snippet whose matches are delimited by U+0002/U+0003 (safe: no HTML). */
export function Highlighted({ text }: { text: string }) {
  // eslint-disable-next-line no-control-regex -- U+0002/U+0003 are the server's highlight markers
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('\u0002') ? (
          <mark key={i} className="rounded bg-warning/30 px-0.5 text-inherit">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        ),
      )}
    </>
  );
}

/** Counts up to `value` (respects prefers-reduced-motion). */
export function AnimatedNumber({ value }: { value: number }) {
  const [shown, setShown] = React.useState(value);
  const from = React.useRef(0);
  React.useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 600);
      const eased = 1 - (1 - p) ** 3;
      setShown(Math.round(origin + (value - origin) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toLocaleString()}</>;
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="okf-lift rounded-lg border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{typeof value === 'number' ? <AnimatedNumber value={value} /> : value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

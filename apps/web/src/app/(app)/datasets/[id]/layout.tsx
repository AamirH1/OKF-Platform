'use client';

import type { DatasetDTO } from '@okf/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Download, EyeOff, MoreHorizontal, Rocket, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { ErrorState, LoadingRows, StatusBadge, VisibilityBadge } from '@/components/common';
import { DatasetProvider, useDataset, useVersions } from '@/components/dataset-context';
import { BundleUploader } from '@/components/upload';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/overlays';
import { Alert, Badge, Select } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';

const TABS = [
  { slug: '', label: 'Overview' },
  { slug: 'preview', label: 'Data Preview' },
  { slug: 'schema', label: 'Schema' },
  { slug: 'metadata', label: 'Metadata' },
  { slug: 'validation', label: 'Validation' },
  { slug: 'versions', label: 'Versions' },
  { slug: 'query', label: 'Query' },
  { slug: 'activity', label: 'Activity', perm: 'dataset:read_drafts' },
  { slug: 'sharing', label: 'Sharing', perm: 'dataset:share' },
] as const;

function DatasetHeader() {
  const { dataset: d, versionParam, versionQs, shared } = useDataset();
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const can = (p: string) => d.permissions.includes(p as never);
  const versions = useVersions(d.id, can('dataset:read_drafts'));
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const refresh = (updated?: DatasetDTO) => {
    if (updated) qc.setQueryData(['dataset', d.id], updated);
    void qc.invalidateQueries({ queryKey: ['versions', d.id] });
  };
  const action = useMutation({
    mutationFn: ({ path, body, method = 'POST' }: { path: string; body?: unknown; method?: 'POST' | 'PUT' }) => api<DatasetDTO>(`/datasets/${d.id}/${path}`, { method, body: body ?? {} }),
    onSuccess: (updated, vars) => {
      refresh(updated);
      toast.success(vars.path === 'publish' ? 'Published' : 'Updated');
    },
  });
  const del = useMutation({
    mutationFn: () => api(`/datasets/${d.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Dataset deleted');
      router.replace('/datasets');
    },
  });
  const download = async () => {
    const r = await api<{ url: string }>(`/datasets/${d.id}/download`, { query: { version: versionParam } });
    window.location.href = r.url;
  };
  const base = `/datasets/${d.id}`;
  const latest = d.latestVersion;
  const publishable = latest && latest.status === 'VALIDATED' && latest.valid;

  return (
    <div className="mb-6 space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            {shared ? 'Shared with you · ' : null}
            {d.organization.name}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="dataset-name">
              {d.name}
            </h1>
            <StatusBadge status={d.status} />
            <VisibilityBadge visibility={d.visibility} />
            {d.tags.map((t) => (
              <Badge key={t} tone="outline">
                {t}
              </Badge>
            ))}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {d.owner ? `Owner ${d.owner.name} · ` : ''}Updated {timeAgo(d.updatedAt)}
            {d.publishedVersion ? ` · Published v${d.publishedVersion.number}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {can('dataset:read_drafts') && versions.data && versions.data.data.length > 0 ? (
            <Select
              aria-label="Version"
              className="h-9 w-40"
              value={versionParam ?? ''}
              onChange={(e) => router.push(`${pathname}${e.target.value ? `?version=${e.target.value}` : ''}`)}
            >
              <option value="">Default version</option>
              {versions.data.data.map((v) => (
                <option key={v.id} value={v.number}>
                  v{v.number} · {v.status.toLowerCase()}
                </option>
              ))}
            </Select>
          ) : null}
          {can('dataset:upload') ? (
            <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <Upload /> New version
                </Button>
              </DialogTrigger>
              <DialogContent title="Upload a new version" description="Each upload becomes a new immutable version." className="max-w-xl">
                <BundleUploader datasetId={d.id} onFinished={() => refresh()} />
              </DialogContent>
            </Dialog>
          ) : null}
          {can('dataset:publish') && publishable ? (
            <Button onClick={() => action.mutate({ path: 'publish' })} disabled={action.isPending} data-testid="publish-button">
              <Rocket /> Publish v{latest.number}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {can('dataset:download') && (d.latestVersion ?? d.publishedVersion) ? (
                <DropdownMenuItem onSelect={() => void download()}>
                  <Download /> Download original archive
                </DropdownMenuItem>
              ) : null}
              {can('dataset:publish') && d.publishedVersion ? (
                <DropdownMenuItem onSelect={() => action.mutate({ path: 'unpublish' })}>
                  <EyeOff /> Unpublish
                </DropdownMenuItem>
              ) : null}
              {can('dataset:archive') ? (
                <DropdownMenuItem onSelect={() => action.mutate({ path: d.archivedAt ? 'unarchive' : 'archive' })}>
                  {d.archivedAt ? <ArchiveRestore /> : <Archive />} {d.archivedAt ? 'Unarchive' : 'Archive'}
                </DropdownMenuItem>
              ) : null}
              {can('dataset:delete') ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onSelect={() => confirm(`Delete "${d.name}" and all its versions? This cannot be undone.`) && del.mutate()}>
                    <Trash2 /> Delete dataset
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {d.archivedAt ? <Alert tone="warning">This dataset is archived and read-only.</Alert> : null}
      <nav className="-mx-1 flex gap-1 overflow-x-auto border-b px-1" aria-label="Dataset sections">
        {TABS.filter((t) => !('perm' in t) || can(t.perm)).map((t) => {
          const href = t.slug ? `${base}/${t.slug}` : base;
          const active = t.slug ? pathname.startsWith(href) : pathname === base;
          return (
            <Link
              key={t.slug}
              href={`${href}${versionQs}`}
              aria-current={active ? 'page' : undefined}
              className={cn('-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap', active ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Re-mount on tab change so each tab fades in. */
function TabBody({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="okf-enter">
      {children}
    </div>
  );
}

export default function DatasetLayout({ children }: { children: React.ReactNode }) {
  return (
    <React.Suspense fallback={<LoadingRows />}>
      <DatasetProvider fallback={<LoadingRows />} error={(e, retry) => <ErrorState error={e} retry={retry} />}>
        <DatasetHeader />
        <TabBody>{children}</TabBody>
      </DatasetProvider>
    </React.Suspense>
  );
}

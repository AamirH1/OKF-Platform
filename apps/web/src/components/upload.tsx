'use client';

import { ALLOWED_UPLOAD_EXTENSIONS, type JobDTO, type VersionDTO } from '@okf/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileArchive, Loader2, RotateCcw, UploadCloud, XCircle } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Progress, Textarea } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { describeUploadError, type UploadProgress, uploadBundle } from '@/lib/upload';
import { cn, formatBytes } from '@/lib/utils';

const STAGES: Record<string, string> = {
  start: 'Queued',
  fetch: 'Fetching upload',
  scan: 'Security scan',
  extract: 'Safe extraction',
  detect: 'Detecting OKF structure',
  analyze: 'Parsing, validating and profiling',
  store: 'Storing files',
  materialize: 'Building query tables',
  index: 'Indexing',
  done: 'Done',
};

/** Polls a job until it finishes and shows its stage/progress. */
export function JobProgress({ jobId, onDone }: { jobId: string; onDone?: (job: JobDTO) => void }) {
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api<JobDTO>(`/jobs/${jobId}`),
    refetchInterval: (q) => (q.state.data && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(q.state.data.status) ? false : 1500),
  });
  const done = React.useRef(false);
  React.useEffect(() => {
    if (job.data && !done.current && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.data.status)) {
      done.current = true;
      onDone?.(job.data);
    }
  }, [job.data, onDone]);
  const j = job.data;
  if (!j) return <p className="text-sm text-muted-foreground">Waiting for the worker…</p>;
  return (
    <div className="space-y-2" data-testid="job-progress">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2">
          {j.status === 'COMPLETED' ? <CheckCircle2 className="size-4 text-success" /> : j.status === 'FAILED' || j.status === 'CANCELLED' ? <XCircle className="size-4 text-destructive" /> : <Loader2 className="size-4 animate-spin" />}
          {j.status === 'QUEUED' ? 'Queued' : (STAGES[j.stage ?? 'start'] ?? j.stage)}
        </span>
        <span className="tabular-nums text-muted-foreground">{j.progress}%</span>
      </div>
      <Progress value={j.progress} label="Processing progress" />
      {j.status === 'QUEUED' || j.status === 'RUNNING' ? (
        <Button variant="ghost" size="sm" onClick={() => void api(`/jobs/${j.id}/cancel`, { method: 'POST' }).then(() => job.refetch())}>
          Cancel processing
        </Button>
      ) : null}
      {j.error && j.status !== 'COMPLETED' ? <p className="text-sm text-destructive">{j.error.message}</p> : null}
    </div>
  );
}

type State =
  | { kind: 'idle' }
  | { kind: 'uploading'; file: File; progress: UploadProgress }
  | { kind: 'error'; file: File; message: string }
  | { kind: 'processing'; version: VersionDTO }
  | { kind: 'finished'; version: VersionDTO; job: JobDTO };

/** Drag-and-drop upload with progress, cancel, retry and live processing status. */
export function BundleUploader({ datasetId, onFinished }: { datasetId: string; onFinished?: () => void }) {
  const qc = useQueryClient();
  const [state, setState] = React.useState<State>({ kind: 'idle' });
  const [dragging, setDragging] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  const abort = React.useRef<AbortController | null>(null);
  const input = React.useRef<HTMLInputElement>(null);

  const start = async (file: File) => {
    if (!ALLOWED_UPLOAD_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      setState({ kind: 'error', file, message: `Unsupported file type. Upload one of: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}` });
      return;
    }
    const ctrl = new AbortController();
    abort.current = ctrl;
    setState({ kind: 'uploading', file, progress: { loaded: 0, total: file.size, phase: 'starting' } });
    try {
      const version = await uploadBundle(datasetId, file, { notes, signal: ctrl.signal, onProgress: (progress) => setState({ kind: 'uploading', file, progress }) });
      setState({ kind: 'processing', version });
      void qc.invalidateQueries({ queryKey: ['dataset', datasetId] });
    } catch (e) {
      setState({ kind: 'error', file, message: describeUploadError(e) });
    }
  };

  const onFinishedJob = React.useCallback(
    (job: JobDTO) => {
      setState((s) => (s.kind === 'processing' ? { kind: 'finished', version: s.version, job } : s));
      void qc.invalidateQueries({ queryKey: ['dataset', datasetId] });
      void qc.invalidateQueries({ queryKey: ['versions', datasetId] });
      onFinished?.();
    },
    [datasetId, onFinished, qc],
  );

  if (state.kind === 'uploading') {
    const pctDone = state.progress.total ? (state.progress.loaded / state.progress.total) * 100 : 0;
    return (
      <div className="space-y-3 rounded-lg border p-4" data-testid="upload-progress">
        <div className="flex items-center gap-2 text-sm">
          <FileArchive className="size-4" />
          <span className="font-medium">{state.file.name}</span>
          <span className="text-muted-foreground">
            {formatBytes(state.progress.loaded)} / {formatBytes(state.progress.total)}
          </span>
        </div>
        <Progress value={pctDone} label="Upload progress" />
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{state.progress.phase === 'finishing' ? 'Finalizing upload…' : state.progress.phase === 'starting' ? 'Preparing…' : 'Uploading directly to storage…'}</span>
          <Button variant="outline" size="sm" onClick={() => abort.current?.abort()} disabled={state.progress.phase === 'finishing'}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  if (state.kind === 'processing' || state.kind === 'finished') {
    const v = state.version;
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="text-sm">
          Version <span className="font-medium">v{v.number}</span> uploaded. Processing runs in the background — you can leave this page.
        </p>
        {v.job ? <JobProgress jobId={v.job.id} onDone={onFinishedJob} /> : null}
        {state.kind === 'finished' ? (
          <div className="flex gap-2">
            <Button asChild size="sm">
              <Link href={`/datasets/${datasetId}/validation?version=${v.number}`}>View validation report</Link>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setState({ kind: 'idle' })}>
              Upload another
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload an OKF bundle: drop a file or press Enter to browse"
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void start(f);
        }}
        className={cn('flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors', dragging ? 'border-primary bg-primary/5' : 'hover:border-primary/50 hover:bg-muted/40')}
      >
        <UploadCloud className="size-8 text-muted-foreground" />
        <p className="mt-2 font-medium">Drop an OKF bundle here, or click to browse</p>
        <p className="mt-1 text-sm text-muted-foreground">A zip or tarball of the bundle directory, or a single concept .md file. Files go straight to object storage.</p>
        <input
          ref={input}
          type="file"
          className="sr-only"
          data-testid="bundle-file-input"
          accept={ALLOWED_UPLOAD_EXTENSIONS.join(',')}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void start(f);
            e.target.value = '';
          }}
        />
      </div>
      <Textarea placeholder="Version notes (optional): what changed in this upload?" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Version notes" rows={2} />
      {state.kind === 'error' ? (
        <Alert tone="danger" title="Upload failed">
          <p>{state.message}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void start(state.file)}>
            <RotateCcw /> Retry {state.file.name}
          </Button>
        </Alert>
      ) : null}
    </div>
  );
}

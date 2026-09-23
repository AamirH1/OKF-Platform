import type { UploadSessionDTO, VersionDTO } from '@okf/shared';
import { api, ApiError } from './api';

export interface UploadProgress {
  loaded: number;
  total: number;
  phase: 'starting' | 'uploading' | 'finishing' | 'done';
}

const MAX_PART_ATTEMPTS = 4;
const PARALLEL_PARTS = 3;

/** PUT one part to its presigned URL with byte-level progress. Resolves to the ETag. */
function putPart(url: string, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(xhr.status >= 200 && xhr.status < 300 ? 'Storage did not expose the ETag header (check bucket CORS).' : `Storage responded ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Network error while uploading'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/**
 * Direct-to-object-storage multipart upload (ADR-0005): the API only signs URLs.
 * Parts upload in parallel with per-part retry and exponential backoff; aborting the
 * signal cancels in-flight parts and aborts the multipart upload server-side.
 */
export async function uploadBundle(
  datasetId: string,
  file: File,
  opts: { notes?: string; signal: AbortSignal; onProgress: (p: UploadProgress) => void; onSession?: (uploadId: string) => void },
): Promise<VersionDTO> {
  const { signal, onProgress } = opts;
  onProgress({ loaded: 0, total: file.size, phase: 'starting' });
  const session = await api<UploadSessionDTO>(`/datasets/${datasetId}/uploads`, {
    method: 'POST',
    body: { filename: file.name, size: file.size, contentType: file.type || 'application/octet-stream', notes: opts.notes ?? '' },
    signal,
  });
  opts.onSession?.(session.uploadId);
  const abortServer = () => void api(`/datasets/${datasetId}/uploads/${session.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
  signal.addEventListener('abort', abortServer, { once: true });

  const loaded = new Map<number, number>();
  const report = () => onProgress({ loaded: [...loaded.values()].reduce((a, b) => a + b, 0), total: file.size, phase: 'uploading' });
  const etags: { partNumber: number; etag: string }[] = [];
  const queue = [...session.parts];
  let urls = new Map(session.parts.map((p) => [p.partNumber, p.url]));

  const worker = async () => {
    while (queue.length > 0) {
      const part = queue.shift()!;
      const start = (part.partNumber - 1) * session.partSize;
      const blob = file.slice(start, Math.min(file.size, start + session.partSize));
      for (let attempt = 1; ; attempt++) {
        try {
          const etag = await putPart(urls.get(part.partNumber)!, blob, (n) => {
            loaded.set(part.partNumber, n);
            report();
          }, signal);
          etags.push({ partNumber: part.partNumber, etag });
          loaded.set(part.partNumber, blob.size);
          report();
          break;
        } catch (e) {
          if (signal.aborted || attempt >= MAX_PART_ATTEMPTS) throw e;
          loaded.set(part.partNumber, 0);
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          // URLs may have expired during a long upload: refresh them (resume endpoint).
          const fresh = await api<UploadSessionDTO>(`/datasets/${datasetId}/uploads/${session.uploadId}`, { signal });
          urls = new Map(fresh.parts.map((p) => [p.partNumber, p.url]));
          if (!urls.has(part.partNumber)) {
            const done = fresh.completedParts.find((p) => p.partNumber === part.partNumber);
            if (done) {
              etags.push({ partNumber: done.partNumber, etag: done.etag });
              break;
            }
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, session.parts.length) }, worker));
  if (signal.aborted) throw new DOMException('Upload cancelled', 'AbortError');

  onProgress({ loaded: file.size, total: file.size, phase: 'finishing' });
  signal.removeEventListener('abort', abortServer);
  const version = await api<VersionDTO>(`/datasets/${datasetId}/uploads/${session.uploadId}/complete`, { method: 'POST', body: { parts: etags } });
  onProgress({ loaded: file.size, total: file.size, phase: 'done' });
  return version;
}

export function describeUploadError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') return 'Upload cancelled.';
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : 'Upload failed.';
}

import type { ApiErrorBody } from '@okf/shared';

/** An API error with the server's code and request ID (shown to users instead of stack traces). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

let shareToken: string | null = null;
/** Set by the share-link page so read requests carry `x-share-token`. */
export function setShareToken(token: string | null): void {
  shareToken = token;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

/** Same-origin JSON client for /api/v1 (proxied to the API by Next.js). */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = `/api/v1${path}${qs.size ? `?${qs}` : ''}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const csrf = readCookie('okf_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (shareToken) headers['x-share-token'] = shareToken;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection and try again.', null);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (e.g. proxy error page)
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? (res.status >= 500 ? 'The server had a problem handling this request.' : res.statusText || 'Request failed'),
      err?.requestId ?? res.headers.get('x-request-id'),
      err?.details,
    );
  }
  return data as T;
}

export const isApiError = (e: unknown, status?: number): e is ApiError => e instanceof ApiError && (status === undefined || e.status === status);

import path from 'node:path';

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function isExternalUrl(url: string): boolean {
  return SCHEME.test(url) || url.startsWith('//');
}

export function conceptIdFromPath(p: string): string {
  return p.replace(/\.md$/i, '');
}

export function basename(p: string): string {
  return path.posix.basename(p);
}

export function isReservedName(p: string): 'index' | 'log' | null {
  const b = basename(p);
  if (b === 'index.md') return 'index';
  if (b === 'log.md') return 'log';
  return null;
}

export type Resolution =
  | { kind: 'external' }
  | { kind: 'anchor' }
  | { kind: 'escapes' }
  | { kind: 'internal'; path: string; isDirectory: boolean };

/**
 * Resolve a link target (OKF §6.1/§6.2) against the linking file.
 * `/x/y.md` is bundle-relative; anything else is relative to the file's directory.
 * Returns a normalized bundle-relative POSIX path without a leading slash.
 */
export function resolveLink(fromFile: string, raw: string): Resolution {
  const url = raw.trim();
  if (url === '' || url.startsWith('#')) return { kind: 'anchor' };
  if (isExternalUrl(url)) return { kind: 'external' };
  let target = url.split('#')[0]!.split('?')[0]!;
  try {
    target = decodeURIComponent(target);
  } catch {
    // keep undecoded
  }
  if (target === '') return { kind: 'anchor' };
  const isDirectory = target.endsWith('/');
  const base = target.startsWith('/') ? '/' : path.posix.join('/', path.posix.dirname(fromFile));
  const joined = path.posix.normalize(path.posix.join(base, target));
  // Detect escapes before normalization hides them: count depth manually.
  if (escapesRoot(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(fromFile), target))) {
    return { kind: 'escapes' };
  }
  const rel = joined.replace(/^\/+/, '').replace(/\/+$/, '');
  return { kind: 'internal', path: rel, isDirectory };
}

function escapesRoot(relPath: string): boolean {
  let depth = 0;
  for (const seg of relPath.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      depth--;
      if (depth < 0) return true;
    } else depth++;
  }
  return false;
}

/**
 * Whether a frontmatter value is plausibly a path (vs. a scope descriptor such as
 * "all queries in BigQuery project X", which §5.1 allows for `sources[].resource`).
 */
export function looksLikePath(value: string): boolean {
  if (isExternalUrl(value)) return false;
  if (/\s/.test(value)) return false;
  return value.includes('/') || /\.[a-zA-Z0-9]{1,8}$/.test(value);
}

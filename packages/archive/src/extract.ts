import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Parser, type ReadEntry } from 'tar';
import yauzl from 'yauzl';

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'markdown';

export type ExtractionErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'EXTENSION_MISMATCH'
  | 'PATH_TRAVERSAL'
  | 'INVALID_PATH'
  | 'LINK_ENTRY'
  | 'SPECIAL_ENTRY'
  | 'ENCRYPTED_ENTRY'
  | 'DUPLICATE_ENTRY'
  | 'TOO_MANY_FILES'
  | 'FILE_TOO_LARGE'
  | 'TOTAL_TOO_LARGE'
  | 'RATIO_EXCEEDED'
  | 'DEPTH_EXCEEDED'
  | 'CORRUPT_ARCHIVE'
  | 'EMPTY_ARCHIVE';

/** A rejected upload. `message` is safe to show to users. */
export class ExtractionError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    message: string,
    readonly entry?: string,
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

export interface ExtractLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  /** Max total uncompressed bytes / archive bytes (zip-bomb guard). */
  maxRatio: number;
  maxDepth: number;
  maxPathLength: number;
}

export const DEFAULT_LIMITS: ExtractLimits = {
  maxFiles: 20_000,
  maxTotalBytes: 2 * 1024 ** 3,
  maxFileBytes: 50 * 1024 ** 2,
  maxRatio: 200,
  maxDepth: 32,
  maxPathLength: 1024,
};

/** Ratios are only meaningful once enough bytes are out; tiny archives of text compress well. */
const RATIO_GRACE_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: { suffix: string; format: ArchiveFormat }[] = [
  { suffix: '.tar.gz', format: 'tar.gz' },
  { suffix: '.tgz', format: 'tar.gz' },
  { suffix: '.tar', format: 'tar' },
  { suffix: '.zip', format: 'zip' },
  { suffix: '.md', format: 'markdown' },
];

export const ALLOWED_EXTENSIONS = EXTENSIONS.map((e) => e.suffix);

export function formatFromFilename(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  return EXTENSIONS.find((e) => lower.endsWith(e.suffix))?.format ?? null;
}

/** Identify the format from magic bytes. */
export function sniffFormat(head: Uint8Array): ArchiveFormat | null {
  const b = head;
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06)) {
    return 'zip';
  }
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'tar.gz';
  if (b.length >= 262 && Buffer.from(b.subarray(257, 262)).toString('latin1') === 'ustar') return 'tar';
  if (b.length > 0 && !b.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b.length === 4096 ? trimPartialUtf8(b) : b);
      return 'markdown';
    } catch {
      return null;
    }
  }
  return null;
}

/** Drop a multi-byte UTF-8 sequence cut off at the end of a sniffed buffer. */
function trimPartialUtf8(b: Uint8Array): Uint8Array {
  const end = b.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const byte = b[end - i]!;
    if ((byte & 0xc0) === 0xc0) return b.subarray(0, end - i);
    if ((byte & 0x80) === 0) break;
  }
  return b;
}

/**
 * Detect format from content and verify it agrees with the filename extension.
 * Content wins; a mismatch is rejected rather than guessed around.
 */
export async function detectFormat(filePath: string, originalName: string): Promise<ArchiveFormat> {
  const fh = await open(filePath, 'r');
  let head: Uint8Array;
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  if (head.length === 0) throw new ExtractionError('EMPTY_ARCHIVE', 'The uploaded file is empty.');
  const byName = formatFromFilename(originalName);
  if (!byName) {
    throw new ExtractionError('UNSUPPORTED_FORMAT', `Unsupported file type. Upload one of: ${ALLOWED_EXTENSIONS.join(', ')}.`);
  }
  const byContent = sniffFormat(head);
  if (!byContent) throw new ExtractionError('UNSUPPORTED_FORMAT', 'File content is not a zip, tar, tar.gz or UTF-8 markdown file.');
  if (byContent !== byName) {
    throw new ExtractionError('EXTENSION_MISMATCH', `The file extension says ${byName} but the content is ${byContent}.`);
  }
  return byContent;
}

/**
 * Validate and normalize an archive entry name to a safe bundle-relative POSIX path.
 * Rejects absolute paths, drive letters, `..` segments, NUL/control characters and
 * over-long or over-deep paths. Backslashes (Windows zips) are treated as separators.
 */
export function safeEntryPath(raw: string, limits: Pick<ExtractLimits, 'maxDepth' | 'maxPathLength'>): string {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f]/.test(raw)) throw new ExtractionError('INVALID_PATH', 'Archive entry name contains control characters.', raw);
  const name = raw.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new ExtractionError('PATH_TRAVERSAL', `Archive entry has an absolute path: ${raw}`, raw);
  }
  const segments = name.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new ExtractionError('PATH_TRAVERSAL', `Archive entry escapes the extraction directory: ${raw}`, raw);
  }
  const normalized = segments.join('/');
  if (normalized.length > limits.maxPathLength) throw new ExtractionError('INVALID_PATH', 'Archive entry path is too long.', raw);
  if (segments.length > limits.maxDepth) throw new ExtractionError('DEPTH_EXCEEDED', `Archive nesting exceeds ${limits.maxDepth} levels.`, raw);
  return normalized.normalize('NFC');
}

export interface ExtractResult {
  format: ArchiveFormat;
  /** Directory to treat as the bundle root (see `detectBundleRoot`). */
  bundleRoot: string;
  fileCount: number;
  totalBytes: number;
}

class Budget {
  files = 0;
  bytes = 0;
  private readonly seen = new Set<string>();
  constructor(
    private readonly limits: ExtractLimits,
    private readonly archiveBytes: number,
  ) {}

  admit(rel: string, declaredSize: number | null): void {
    const key = rel.toLowerCase();
    if (this.seen.has(key)) throw new ExtractionError('DUPLICATE_ENTRY', `Archive contains the path twice (case-insensitively): ${rel}`, rel);
    this.seen.add(key);
    if (++this.files > this.limits.maxFiles) throw new ExtractionError('TOO_MANY_FILES', `Archive contains more than ${this.limits.maxFiles} files.`);
    if (declaredSize !== null && declaredSize > this.limits.maxFileBytes) {
      throw new ExtractionError('FILE_TOO_LARGE', `${rel} exceeds the ${this.limits.maxFileBytes}-byte per-file limit.`, rel);
    }
  }

  /** Count bytes as they are actually written; never trust header sizes. */
  meter(rel: string): Transform {
    let fileBytes = 0;
    return new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        fileBytes += chunk.length;
        this.bytes += chunk.length;
        if (fileBytes > this.limits.maxFileBytes) {
          return cb(new ExtractionError('FILE_TOO_LARGE', `${rel} exceeds the ${this.limits.maxFileBytes}-byte per-file limit.`, rel));
        }
        if (this.bytes > this.limits.maxTotalBytes) {
          return cb(new ExtractionError('TOTAL_TOO_LARGE', `Archive expands beyond ${this.limits.maxTotalBytes} bytes.`));
        }
        if (this.bytes > RATIO_GRACE_BYTES && this.bytes / Math.max(1, this.archiveBytes) > this.limits.maxRatio) {
          return cb(new ExtractionError('RATIO_EXCEEDED', `Archive compression ratio exceeds ${this.limits.maxRatio}:1 (possible zip bomb).`));
        }
        cb(null, chunk);
      },
    });
  }
}

async function writeEntry(dest: string, rel: string, stream: Readable, budget: Budget): Promise<void> {
  const target = path.resolve(dest, rel);
  if (!target.startsWith(path.resolve(dest) + path.sep)) {
    throw new ExtractionError('PATH_TRAVERSAL', `Archive entry escapes the extraction directory: ${rel}`, rel);
  }
  await mkdir(path.dirname(target), { recursive: true });
  // `wx` refuses to overwrite and never follows an existing symlink at the target.
  await pipeline(stream, budget.meter(rel), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

async function extractZip(archive: string, dest: string, budget: Budget, limits: ExtractLimits): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, autoClose: true }, (err, z) => {
      if (err || !z) reject(new ExtractionError('CORRUPT_ARCHIVE', `Could not read zip archive: ${err?.message ?? 'unknown error'}`));
      else resolve(z);
    });
  });
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (e: unknown) => {
      if (failed) return;
      failed = true;
      zip.close();
      const msg = (e as Error).message ?? '';
      // yauzl validates names itself before we see the entry.
      if (/invalid relative path|absolute path/i.test(msg)) {
        reject(new ExtractionError('PATH_TRAVERSAL', `Archive entry escapes the extraction directory (${msg}).`));
        return;
      }
      if (/encrypt/i.test(msg)) {
        reject(new ExtractionError('ENCRYPTED_ENTRY', 'Encrypted zip entries are not supported.'));
        return;
      }
      reject(e instanceof ExtractionError ? e : new ExtractionError('CORRUPT_ARCHIVE', `Corrupt zip archive: ${msg}`));
    };
    zip.on('error', fail);
    zip.on('end', () => !failed && resolve());
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const isDir = entry.fileName.endsWith('/');
        const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
        if (mode === S_IFLNK) throw new ExtractionError('LINK_ENTRY', `Archive contains a symbolic link: ${entry.fileName}`, entry.fileName);
        if (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) {
          throw new ExtractionError('SPECIAL_ENTRY', `Archive contains a special file: ${entry.fileName}`, entry.fileName);
        }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          throw new ExtractionError('ENCRYPTED_ENTRY', `Encrypted zip entries are not supported: ${entry.fileName}`, entry.fileName);
        }
        const rel = safeEntryPath(entry.fileName, limits);
        if (isDir || rel === '') {
          zip.readEntry();
          return;
        }
        budget.admit(rel, entry.uncompressedSize);
        const stream = await new Promise<Readable>((res, rej) =>
          zip.openReadStream(entry, (err, s) => (err || !s ? rej(err ?? new Error('no stream')) : res(s))),
        );
        await writeEntry(dest, rel, stream, budget);
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

const TAR_FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);
const TAR_META_TYPES = new Set(['GlobalExtendedHeader', 'ExtendedHeader', 'OldExtendedHeader', 'NextFileHasLongPath', 'OldGnuLongPath', 'NextFileHasLongLinkpath']);

async function extractTar(archive: string, dest: string, budget: Budget, limits: ExtractLimits): Promise<void> {
  const { createReadStream } = await import('node:fs');
  const pending: Promise<void>[] = [];
  let firstError: unknown = null;
  const parser = new Parser({
    strict: true,
    onReadEntry: (entry: ReadEntry) => {
      if (firstError) return entry.resume();
      try {
        if (entry.type === 'Directory' || TAR_META_TYPES.has(entry.type)) return entry.resume();
        if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
          throw new ExtractionError('LINK_ENTRY', `Archive contains a link: ${entry.path}`, entry.path);
        }
        if (!TAR_FILE_TYPES.has(entry.type)) throw new ExtractionError('SPECIAL_ENTRY', `Archive contains a special entry (${entry.type}): ${entry.path}`, entry.path);
        const rel = safeEntryPath(entry.path, limits);
        if (rel === '') return entry.resume();
        budget.admit(rel, entry.size ?? null);
        entry.pause();
        pending.push(
          writeEntry(dest, rel, entry as unknown as Readable, budget).catch((e: unknown) => {
            firstError ??= e;
            parser.abort(e as Error);
          }),
        );
      } catch (e) {
        firstError ??= e;
        entry.resume();
        parser.abort(e as Error);
      }
    },
  });
  try {
    await pipeline(createReadStream(archive), parser);
  } catch (e) {
    firstError ??= e;
  }
  await Promise.allSettled(pending);
  if (firstError) {
    if (firstError instanceof ExtractionError) throw firstError;
    throw new ExtractionError('CORRUPT_ARCHIVE', `Corrupt tar archive: ${(firstError as Error).message}`);
  }
}

/**
 * Extract an uploaded file into `dest` (which must be empty or absent) enforcing every limit.
 * On any violation the partial output is deleted and an `ExtractionError` is thrown.
 */
export async function extractArchive(
  archivePath: string,
  originalName: string,
  dest: string,
  limits: ExtractLimits = DEFAULT_LIMITS,
): Promise<ExtractResult> {
  const format = await detectFormat(archivePath, originalName);
  const archiveBytes = (await stat(archivePath)).size;
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const budget = new Budget(limits, archiveBytes);
  try {
    if (format === 'zip') await extractZip(archivePath, dest, budget, limits);
    else if (format === 'tar' || format === 'tar.gz') await extractTar(archivePath, dest, budget, limits);
    else {
      const rel = safeEntryPath(path.basename(originalName), limits);
      budget.admit(rel, archiveBytes);
      const { createReadStream } = await import('node:fs');
      await writeEntry(dest, rel, createReadStream(archivePath), budget);
    }
  } catch (e) {
    await rm(dest, { recursive: true, force: true });
    throw e;
  }
  if (budget.files === 0) {
    await rm(dest, { recursive: true, force: true });
    throw new ExtractionError('EMPTY_ARCHIVE', 'The archive contains no files.');
  }
  return { format, bundleRoot: await detectBundleRoot(dest), fileCount: budget.files, totalBytes: budget.bytes };
}

/**
 * Tarballs and GitHub/zip downloads usually wrap content in a single top-level folder.
 * If the extracted tree has exactly one directory and no files at the top level
 * (ignoring dot-files and `__MACOSX`), that directory is the bundle root.
 */
export async function detectBundleRoot(dir: string): Promise<string> {
  let root = dir;
  for (let i = 0; i < 3; i++) {
    const entries = (await readdir(root, { withFileTypes: true })).filter((e) => !e.name.startsWith('.') && e.name !== '__MACOSX');
    const only = entries[0];
    if (entries.length === 1 && only?.isDirectory()) root = path.join(root, only.name);
    else break;
  }
  return root;
}

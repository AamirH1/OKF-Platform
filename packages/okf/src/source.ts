import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface SourceFile {
  /** Bundle-relative POSIX path. */
  path: string;
  size: number;
}

/** Read-only view of a bundle's files. Implementations never follow symlinks. */
export interface BundleSource {
  list(): Promise<SourceFile[]>;
  read(filePath: string): Promise<Uint8Array>;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** In-memory bundle, used by tests and for single-file uploads. */
export class MemorySource implements BundleSource {
  private readonly files: Map<string, Uint8Array>;

  constructor(files: Record<string, string | Uint8Array>) {
    const enc = new TextEncoder();
    this.files = new Map(
      Object.entries(files).map(([p, c]) => [p, typeof c === 'string' ? enc.encode(c) : c]),
    );
  }

  async list(): Promise<SourceFile[]> {
    return [...this.files.entries()]
      .map(([p, c]) => ({ path: p, size: c.byteLength }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(filePath: string): Promise<Uint8Array> {
    const c = this.files.get(filePath);
    if (!c) throw new Error(`No such file in bundle: ${filePath}`);
    return c;
  }
}

/**
 * Bundle rooted at a directory on disk. Symlinks and special files are skipped;
 * extraction (packages/archive) never creates them, this is defence in depth.
 */
export class DirectorySource implements BundleSource {
  constructor(private readonly root: string) {}

  async list(): Promise<SourceFile[]> {
    const out: SourceFile[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(abs, relPath);
        else if (e.isFile()) out.push({ path: relPath, size: (await lstat(abs)).size });
      }
    };
    await walk(this.root, '');
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(filePath: string): Promise<Uint8Array> {
    const abs = path.resolve(this.root, filePath);
    const rootWithSep = path.resolve(this.root) + path.sep;
    if (!abs.startsWith(rootWithSep)) throw new Error(`Path escapes bundle root: ${filePath}`);
    return readFile(abs);
  }
}

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  extractArchive,
  ExtractionError,
  parseClamdReply,
  safeEntryPath,
  sniffFormat,
  type ExtractLimits,
} from '../src';
import { buildTar, buildZip } from './builders';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'okf-archive-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const concept = '---\ntype: Reference\ndescription: x\n---\n\nbody\n';

async function extract(name: string, bytes: Buffer, limits: Partial<ExtractLimits> = {}) {
  const file = path.join(tmp, name);
  await writeFile(file, bytes);
  return extractArchive(file, name, path.join(tmp, 'out'), { ...DEFAULT_LIMITS, ...limits });
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(ExtractionError);
  expect((err as ExtractionError).code).toBe(code);
  expect(existsSync(path.join(tmp, 'out')), 'partial output removed').toBe(false);
}

describe('extractArchive — happy paths', () => {
  it('extracts a zip and unwraps a single top-level folder', async () => {
    const zip = buildZip([
      { name: 'bundle/' },
      { name: 'bundle/index.md', data: '# Index\n' },
      { name: 'bundle/tables/orders.md', data: concept, deflate: true },
      { name: '__MACOSX/bundle/._orders.md', data: 'junk' },
    ]);
    const r = await extract('b.zip', zip);
    expect(r.format).toBe('zip');
    expect(r.bundleRoot).toBe(path.join(tmp, 'out', 'bundle'));
    expect(await readFile(path.join(r.bundleRoot, 'tables/orders.md'), 'utf8')).toBe(concept);
  });

  it('extracts tar and tar.gz', async () => {
    const entries = [{ name: 'index.md', data: '# x\n' }, { name: 'dir/', type: '5' as const }, { name: 'dir/a.md', data: concept }];
    const tar = await extract('b.tar', buildTar(entries));
    expect(tar.format).toBe('tar');
    expect(tar.fileCount).toBe(2);
    await rm(path.join(tmp, 'out'), { recursive: true });
    const tgz = await extract('b.tgz', buildTar(entries, true));
    expect(tgz.format).toBe('tar.gz');
    expect((await readdir(tgz.bundleRoot)).sort()).toEqual(['dir', 'index.md']);
  });

  it('accepts a single markdown file', async () => {
    const r = await extract('orders.md', Buffer.from(concept));
    expect(r.format).toBe('markdown');
    expect(await readdir(r.bundleRoot)).toEqual(['orders.md']);
  });

  it('normalizes Windows separators', async () => {
    const r = await extract('w.zip', buildZip([{ name: 'index.md', data: '# i\n' }, { name: 'tables\\a.md', data: concept }]));
    expect(existsSync(path.join(r.bundleRoot, 'tables', 'a.md'))).toBe(true);
  });
});

describe('extractArchive — hostile input', () => {
  it('rejects zip-slip traversal', () => rejects(extract('z.zip', buildZip([{ name: '../evil.md', data: 'x' }])), 'PATH_TRAVERSAL'));
  it('rejects nested traversal', () => rejects(extract('z.zip', buildZip([{ name: 'a/../../evil.md', data: 'x' }])), 'PATH_TRAVERSAL'));
  it('rejects absolute zip paths', () => rejects(extract('z.zip', buildZip([{ name: '/etc/evil.md', data: 'x' }])), 'PATH_TRAVERSAL'));
  it('rejects zip symlinks', () =>
    rejects(extract('z.zip', buildZip([{ name: 'link.md', data: '/etc/passwd', mode: 0o120777 }])), 'LINK_ENTRY'));
  it('rejects encrypted zip entries', () =>
    rejects(extract('z.zip', buildZip([{ name: 'a.md', data: 'x', encrypted: true }])), 'ENCRYPTED_ENTRY'));
  it('rejects duplicate entries (case-insensitive)', () =>
    rejects(extract('z.zip', buildZip([{ name: 'A.md', data: 'x' }, { name: 'a.md', data: 'y' }])), 'DUPLICATE_ENTRY'));
  it('enforces the file count limit', () =>
    rejects(extract('z.zip', buildZip([1, 2, 3, 4].map((i) => ({ name: `${i}.md`, data: 'x' }))), { maxFiles: 3 }), 'TOO_MANY_FILES'));
  it('enforces the per-file size limit on declared size', () =>
    rejects(extract('z.zip', buildZip([{ name: 'big.md', data: Buffer.alloc(2048), deflate: true }]), { maxFileBytes: 1024 }), 'FILE_TOO_LARGE'));
  it('enforces the total size limit on actual bytes', () =>
    rejects(
      extract('z.zip', buildZip([1, 2, 3].map((i) => ({ name: `${i}.md`, data: Buffer.alloc(800), deflate: true }))), { maxTotalBytes: 2000 }),
      'TOTAL_TOO_LARGE',
    ));
  it('detects compression-ratio bombs', () =>
    rejects(extract('bomb.zip', buildZip([{ name: 'zeros.md', data: Buffer.alloc(24 * 1024 * 1024), deflate: true }]), { maxRatio: 100 }), 'RATIO_EXCEEDED'));
  it('enforces depth', () =>
    rejects(extract('z.zip', buildZip([{ name: 'a/b/c/d/e.md', data: 'x' }]), { maxDepth: 3 }), 'DEPTH_EXCEEDED'));

  it('rejects tar symlinks, hardlinks and devices', async () => {
    await rejects(extract('t.tar', buildTar([{ name: 'l.md', type: '2', linkname: '/etc/passwd' }])), 'LINK_ENTRY');
    await rejects(extract('t.tar', buildTar([{ name: 'h.md', type: '1', linkname: 'x.md' }])), 'LINK_ENTRY');
    await rejects(extract('t.tar', buildTar([{ name: 'dev', type: '3' }])), 'SPECIAL_ENTRY');
  });
  it('rejects tar traversal', () => rejects(extract('t.tar.gz', buildTar([{ name: '../../evil.md', data: 'x' }], true)), 'PATH_TRAVERSAL'));
  it('rejects corrupt archives', () => rejects(extract('c.zip', Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(100, 7)])), 'CORRUPT_ARCHIVE'));
  it('rejects extension/content mismatch', () => rejects(extract('b.tar.gz', buildZip([{ name: 'a.md', data: 'x' }])), 'EXTENSION_MISMATCH'));
  it('rejects unsupported extensions', () => rejects(extract('b.exe', Buffer.from('MZ\u0090\u0000')), 'UNSUPPORTED_FORMAT'));
  it('rejects binary content named .md', () => rejects(extract('b.md', Buffer.from([0, 1, 2, 3, 255])), 'UNSUPPORTED_FORMAT'));
  it('rejects empty uploads and empty archives', async () => {
    await rejects(extract('e.md', Buffer.alloc(0)), 'EMPTY_ARCHIVE');
    await rejects(extract('e.zip', buildZip([{ name: 'dir/' }])), 'EMPTY_ARCHIVE');
  });
});

describe('helpers', () => {
  it('safeEntryPath', () => {
    const lim = { maxDepth: 10, maxPathLength: 100 };
    expect(safeEntryPath('./a//b/./c.md', lim)).toBe('a/b/c.md');
    expect(() => safeEntryPath('C:\\x.md', lim)).toThrow(ExtractionError);
    expect(() => safeEntryPath('a\u0000.md', lim)).toThrow(/control characters/);
    expect(safeEntryPath('cafe\u0301.md', lim)).toBe('café.md');
  });

  it('sniffFormat', () => {
    expect(sniffFormat(buildZip([{ name: 'a', data: 'b' }]))).toBe('zip');
    expect(sniffFormat(buildTar([{ name: 'a', data: 'b' }], true))).toBe('tar.gz');
    expect(sniffFormat(buildTar([{ name: 'a', data: 'b' }]))).toBe('tar');
    expect(sniffFormat(Buffer.from('---\ntype: x\n---\n'))).toBe('markdown');
  });

  it('parseClamdReply fails closed', () => {
    expect(parseClamdReply('stream: OK')).toEqual({ clean: true });
    expect(parseClamdReply('stream: Eicar-Test-Signature FOUND')).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
    expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR')).toThrow();
  });
});

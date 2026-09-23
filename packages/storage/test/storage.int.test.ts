import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@okf/config';
import { createStorage, storageKeys } from '../src';

const env = loadEnv();
const storage = createStorage(env);
const prefix = `it/${randomUUID()}/`;

afterAll(async () => {
  await storage.deletePrefix(prefix);
});

describe('S3Storage (MinIO)', () => {
  it('pings the test bucket', async () => {
    expect(env.S3_BUCKET).toMatch(/-test$/);
    await expect(storage.ping()).resolves.toBeUndefined();
  });

  it('puts, heads, reads and deletes objects', async () => {
    const key = `${prefix}hello.txt`;
    await storage.putObject(key, 'hello world', 'text/plain');
    expect(await storage.head(key)).toMatchObject({ size: 11, contentType: 'text/plain' });
    expect((await storage.getBuffer(key)).toString()).toBe('hello world');
    await expect(storage.getBuffer(key, 5)).rejects.toThrow(/exceeds/);
    expect(await storage.head(`${prefix}missing`)).toBeNull();
  });

  it('completes a presigned multipart upload the way the browser does', async () => {
    const key = `${prefix}multi/archive`;
    const uploadId = await storage.createMultipartUpload(key, 'application/zip');
    const part1 = Buffer.alloc(5 * 1024 * 1024, 1);
    const part2 = Buffer.from('tail');
    const etags: { partNumber: number; etag: string }[] = [];
    for (const [i, body] of [part1, part2].entries()) {
      const url = await storage.presignUploadPart(key, uploadId, i + 1, 300);
      const res = await fetch(url, { method: 'PUT', body });
      expect(res.status).toBe(200);
      etags.push({ partNumber: i + 1, etag: res.headers.get('etag')! });
    }
    const listed = await storage.listParts(key, uploadId);
    expect(listed.map((p) => p.partNumber)).toEqual([1, 2]);
    await storage.completeMultipartUpload(key, uploadId, etags);
    expect((await storage.head(key))?.size).toBe(part1.length + part2.length);
  });

  it('aborts multipart uploads idempotently', async () => {
    const key = `${prefix}aborted`;
    const uploadId = await storage.createMultipartUpload(key, 'application/zip');
    await storage.abortMultipartUpload(key, uploadId);
    await expect(storage.abortMultipartUpload(key, uploadId)).resolves.toBeUndefined();
  });

  it('allows the web origin to PUT parts and read the ETag (CORS)', async () => {
    const key = `${prefix}cors`;
    const uploadId = await storage.createMultipartUpload(key, 'application/zip');
    const url = await storage.presignUploadPart(key, uploadId, 1, 300);
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: env.WEB_ORIGIN, 'Access-Control-Request-Method': 'PUT' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(env.WEB_ORIGIN);
    const put = await fetch(url, { method: 'PUT', body: 'x', headers: { Origin: env.WEB_ORIGIN } });
    expect(put.headers.get('access-control-expose-headers') ?? '').toMatch(/etag/i);
    await storage.abortMultipartUpload(key, uploadId);
  });

  it('presigns downloads with a safe content-disposition', async () => {
    const key = `${prefix}dl.txt`;
    await storage.putObject(key, 'data');
    const url = await storage.presignGet(key, 60, 'my "bundle".tar.gz');
    const res = await fetch(url);
    expect(await res.text()).toBe('data');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="my _bundle_.tar.gz"');
  });

  it('builds tenant-scoped keys', () => {
    expect(storageKeys.blob('org1', 'abcdef')).toBe('blobs/org1/ab/abcdef');
    expect(storageKeys.analytics('org1', 'v1', 'concepts')).toBe('analytics/org1/v1/concepts.parquet');
  });
});

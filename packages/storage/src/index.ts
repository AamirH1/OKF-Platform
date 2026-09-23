import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ObjectHead {
  size: number;
  etag: string | null;
  contentType: string | null;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/** Storage abstraction; S3Storage works with AWS S3, MinIO and GCS (XML API + HMAC). */
export interface ObjectStorage {
  readonly bucket: string;
  ping(): Promise<void>;
  putObject(key: string, body: Buffer | string, contentType?: string): Promise<void>;
  putFile(key: string, filePath: string, contentType?: string): Promise<void>;
  getStream(key: string): Promise<Readable>;
  getBuffer(key: string, maxBytes?: number): Promise<Buffer>;
  downloadToFile(key: string, dest: string): Promise<void>;
  head(key: string): Promise<ObjectHead | null>;
  deletePrefix(prefix: string): Promise<number>;
  deleteKeys(keys: string[]): Promise<void>;
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  presignGet(key: string, expiresInSeconds: number, downloadName?: string): Promise<string>;
}

export class ObjectTooLargeError extends Error {}

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  /** Endpoint browsers use for presigned URLs (e.g. public hostname in front of MinIO). */
  publicEndpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const isNotFound = (e: unknown) =>
  e instanceof NotFound ||
  e instanceof NoSuchKey ||
  (typeof e === 'object' && e !== null && '$metadata' in e && (e as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode === 404);

export class S3Storage implements ObjectStorage {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly presigner: S3Client;

  constructor(opts: S3StorageOptions) {
    this.bucket = opts.bucket;
    const base = {
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      // Checksums on every request break presigned browser PUTs against MinIO/GCS.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = new S3Client({ ...base, ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) });
    const pub = opts.publicEndpoint || opts.endpoint;
    this.presigner = new S3Client({ ...base, ...(pub ? { endpoint: pub } : {}) });
  }

  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async putObject(key: string, body: Buffer | string, contentType = 'application/octet-stream'): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async putFile(key: string, filePath: string, contentType = 'application/octet-stream'): Promise<void> {
    const { size } = await stat(filePath);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(filePath), ContentLength: size, ContentType: contentType }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty body for ${key}`);
    return res.Body as Readable;
  }

  async getBuffer(key: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) {
        stream.destroy();
        throw new ObjectTooLargeError(`${key} exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async downloadToFile(key: string, dest: string): Promise<void> {
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(await this.getStream(key), createWriteStream(dest));
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, etag: res.ETag ?? null, contentType: res.ContentType ?? null };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (batch.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }),
      );
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix || !prefix.endsWith('/')) throw new Error('deletePrefix requires a non-empty prefix ending in "/"');
    let token: string | undefined;
    let count = 0;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => o.Key!).filter(Boolean);
      await this.deleteKeys(keys);
      count += keys.length;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return count;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const res = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    if (!res.UploadId) throw new Error('Storage did not return an UploadId');
    return res.UploadId;
  }

  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: expiresInSeconds },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const res = await this.client.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
      );
      for (const p of res.Parts ?? []) {
        if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size ?? 0 });
      }
      marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  presignGet(key: string, expiresInSeconds: number, downloadName?: string): Promise<string> {
    const disposition = downloadName ? `attachment; filename="${downloadName.replace(/["\\\r\n]/g, '_')}"` : undefined;
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition }),
      { expiresIn: expiresInSeconds },
    );
  }
}

/** Object key layout (docs/architecture.md §5). Tenant ID is always the first path segment after the area. */
export const storageKeys = {
  upload: (orgId: string, uploadId: string) => `uploads/${orgId}/${uploadId}/archive`,
  blob: (orgId: string, sha256: string) => `blobs/${orgId}/${sha256.slice(0, 2)}/${sha256}`,
  analyticsPrefix: (orgId: string, versionId: string) => `analytics/${orgId}/${versionId}/`,
  analytics: (orgId: string, versionId: string, name: 'concepts' | 'links' | 'schema_columns') =>
    `analytics/${orgId}/${versionId}/${name}.parquet`,
  export: (orgId: string, versionId: string) => `exports/${orgId}/${versionId}/bundle.tar.gz`,
};

export function createStorage(env: {
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ENDPOINT: string;
  S3_PUBLIC_ENDPOINT: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_FORCE_PATH_STYLE: boolean;
}): S3Storage {
  return new S3Storage({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT || undefined,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}

export { Readable };

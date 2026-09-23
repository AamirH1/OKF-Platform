import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactPaths, QueryTarget, TableName } from '@okf/query';
import { TABLE_NAMES } from '@okf/query';
import { type ObjectStorage, storageKeys } from '@okf/storage';

/**
 * Resolve a version's parquet artifacts to local files, downloading once into the cache.
 * Versions are immutable, so cached files never go stale; concurrent requests share one download.
 */
export function createArtifactLoader(storage: ObjectStorage, cacheDir: string) {
  const inflight = new Map<string, Promise<ArtifactPaths>>();
  return async (target: QueryTarget): Promise<ArtifactPaths> => {
    const key = target.versionId;
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const dir = path.resolve(cacheDir, target.organizationId, target.versionId);
      const out = {} as ArtifactPaths;
      await mkdir(dir, { recursive: true });
      for (const table of TABLE_NAMES as TableName[]) {
        const file = path.join(dir, `${table}.parquet`);
        if (!existsSync(file)) {
          const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
          try {
            await storage.downloadToFile(storageKeys.analytics(target.organizationId, target.versionId, table), tmp);
            await rename(tmp, file);
          } catch (e) {
            await rm(tmp, { force: true });
            throw e;
          }
        }
        out[table] = file;
      }
      return out;
    })();
    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  };
}

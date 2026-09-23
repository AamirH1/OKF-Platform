import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractArchive, ExtractionError, safeFetchToFile, ScannerUnavailableError, UrlGuardError } from '@okf/archive';
import { analyzeBundle, DirectorySource } from '@okf/core';
import {
  auditLogs,
  conceptLinks,
  concepts,
  datasetFiles,
  datasetVersions,
  eq,
  type Job,
  refreshDatasetStatus,
  schemaColumns,
  validationIssues,
  validationRuns,
} from '@okf/db';
import { writeParquetArtifacts } from '@okf/query';
import { storageKeys } from '@okf/storage';
import { type JobContext, JobFailure, type JobHandler, type WorkerDeps } from '../context';
import { failVersion } from '../runner';
import { artifactRows, buildSearchText, chunk, conceptRowValues, contentTypeFor } from './rows';

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const c of createReadStream(file)) hash.update(c as Buffer);
  return hash.digest('hex');
}

async function hasMarkdown(dir: string): Promise<boolean> {
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && /\.md$/i.test(e.name)) return true;
  }
  return false;
}

/** Run `fn` with bounded concurrency. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

export function ingestHandler(deps: WorkerDeps): JobHandler {
  const { db, storage, scanner, env, metrics } = deps;
  const now = deps.now ?? (() => new Date());

  const timed = async <T>(ctx: JobContext, stage: string, percent: number, fn: () => Promise<T>): Promise<T> => {
    await ctx.progress(stage, percent);
    const end = metrics.stageDuration.startTimer({ stage });
    try {
      return await fn();
    } finally {
      end();
    }
  };

  return {
    onTerminalFailure: (job: Job, failure) => failVersion(deps, job, failure),

    async run(ctx) {
      const { job, log } = ctx;
      if (!job.versionId || !job.datasetId || !job.organizationId) throw new JobFailure('BAD_JOB', 'Ingestion job is missing its version.');
      const [version] = await db.select().from(datasetVersions).where(eq(datasetVersions.id, job.versionId));
      if (!version) throw new JobFailure('VERSION_GONE', 'The version no longer exists.');
      if (version.status !== 'PROCESSING') {
        log.info({ status: version.status }, 'version already processed; nothing to do');
        return { skipped: true };
      }
      const orgId = version.organizationId;
      const tmpRoot = await mkdtemp(path.join(env.WORKER_TEMP_DIR || os.tmpdir(), 'okf-ingest-'));
      const archive = path.join(tmpRoot, 'archive');
      try {
        // 1. Fetch the raw upload (or import from URL) into the worker's temp dir.
        await timed(ctx, 'fetch', 5, async () => {
          if (version.sourceType === 'import') {
            if (!version.sourceUrl) throw new JobFailure('BAD_IMPORT', 'Import has no URL.', 'fetch');
            try {
              await safeFetchToFile(version.sourceUrl, archive, {
                allowHttp: env.IMPORT_ALLOW_HTTP,
                allowedHosts: env.IMPORT_ALLOWED_HOSTS,
                allowPrivate: env.IMPORT_ALLOW_PRIVATE_NETWORKS,
                maxBytes: env.IMPORT_MAX_BYTES,
                timeoutMs: env.IMPORT_TIMEOUT_MS,
              });
            } catch (e) {
              if (e instanceof UrlGuardError) throw new JobFailure('IMPORT_FAILED', e.message, 'fetch', /timed out|HTTP 5\d\d|Could not fetch/.test(e.message));
              throw e;
            }
            await storage.putFile(version.archiveKey, archive, 'application/octet-stream');
          } else {
            try {
              await storage.downloadToFile(version.archiveKey, archive);
            } catch (e) {
              metrics.storageErrors.inc();
              throw new JobFailure('STORAGE_ERROR', `Could not read the uploaded file: ${(e as Error).message}`, 'fetch', true);
            }
          }
        });
        const archiveSize = (await stat(archive)).size;
        const archiveSha256 = await sha256File(archive);
        await db.update(datasetVersions).set({ archiveSize, archiveSha256 }).where(eq(datasetVersions.id, version.id));

        // 2. Malware scan (fails closed when a scanner is configured).
        const scanStatus = await timed(ctx, 'scan', 15, async () => {
          if (scanner.name === 'none') return 'skipped' as const;
          try {
            const verdict = await scanner.scanFile(archive);
            if (!verdict.clean) throw new JobFailure('MALWARE_DETECTED', `The upload was rejected by malware scanning (${verdict.signature}).`, 'scan');
            return 'clean' as const;
          } catch (e) {
            if (e instanceof ScannerUnavailableError) throw new JobFailure('SCANNER_UNAVAILABLE', 'Malware scanning is temporarily unavailable.', 'scan', true);
            throw e;
          }
        });

        // 3–4. File type detection + safe extraction.
        const extracted = await timed(ctx, 'extract', 25, async () => {
          try {
            return await extractArchive(archive, version.originalFilename, path.join(tmpRoot, 'bundle'), {
              maxFiles: env.EXTRACT_MAX_FILES,
              maxTotalBytes: env.EXTRACT_MAX_TOTAL_BYTES,
              maxFileBytes: env.EXTRACT_MAX_FILE_BYTES,
              maxRatio: env.EXTRACT_MAX_RATIO,
              maxDepth: env.EXTRACT_MAX_DEPTH,
              maxPathLength: 1024,
            });
          } catch (e) {
            if (e instanceof ExtractionError) throw new JobFailure(e.code, e.message, 'extract');
            throw e;
          }
        });

        // 5. OKF structure detection.
        await timed(ctx, 'detect', 30, async () => {
          if (!(await hasMarkdown(extracted.bundleRoot))) {
            throw new JobFailure('NOT_OKF_BUNDLE', 'No markdown files were found, so this is not an OKF bundle (OKF §3: a bundle is a directory of markdown files).', 'detect');
          }
        });

        // 6–8. Parse metadata + schema, validate (structural vs quality), profile.
        const analysis = await timed(ctx, 'analyze', 40, () =>
          analyzeBundle(new DirectorySource(extracted.bundleRoot), {
            now: now(),
            onProgress: async (done, total) => {
              await ctx.progress('analyze', 40 + Math.floor((done / Math.max(1, total)) * 20));
            },
          }),
        );
        if (!analysis.validation.valid) metrics.validationFailures.inc();

        // 9. Store every file content-addressed (deduplicated within the organization).
        await timed(ctx, 'store', 65, async () => {
          const unique = [...new Map(analysis.files.map((f) => [f.sha256, f])).values()];
          let done = 0;
          await pool(unique, 8, async (f) => {
            const key = storageKeys.blob(orgId, f.sha256);
            if (!(await storage.head(key))) await storage.putFile(key, path.join(extracted.bundleRoot, f.path), contentTypeFor(f.path));
            if (++done % 100 === 0) await ctx.progress('store', 65 + Math.floor((done / unique.length) * 10));
          });
        });

        // 10. Query artifacts (parquet) for DuckDB.
        await timed(ctx, 'materialize', 78, async () => {
          const paths = await writeParquetArtifacts(path.join(tmpRoot, 'analytics'), artifactRows(analysis));
          for (const [table, file] of Object.entries(paths)) {
            await storage.putFile(storageKeys.analytics(orgId, version.id, table as 'concepts'), file, 'application/vnd.apache.parquet');
          }
        });

        // 11. Index metadata in Postgres and finalize — one transaction, idempotent on retry.
        const v = analysis.validation;
        await timed(ctx, 'index', 88, () =>
          db.transaction(async (tx) => {
            for (const t of [datasetFiles, concepts, conceptLinks, schemaColumns, validationRuns]) {
              await tx.delete(t).where(eq(t.versionId, version.id));
            }
            for (const batch of chunk(analysis.files, 1000)) {
              await tx.insert(datasetFiles).values(
                batch.map((f) => ({ versionId: version.id, path: f.path, kind: f.kind, size: f.size, sha256: f.sha256, storageKey: storageKeys.blob(orgId, f.sha256), contentType: contentTypeFor(f.path) })),
              );
            }
            for (const batch of chunk(analysis.concepts, 250)) {
              await tx.insert(concepts).values(batch.map((c) => ({ ...conceptRowValues(c), versionId: version.id, datasetId: version.datasetId, organizationId: orgId })));
            }
            const links = analysis.concepts.flatMap((c) =>
              c.links.map((l) => ({ versionId: version.id, sourceConceptId: c.id, via: l.via, kind: l.kind, raw: l.raw.slice(0, 2048), targetPath: l.targetPath, targetConceptId: l.targetConceptId, broken: l.broken, line: l.line, text: l.text?.slice(0, 500) ?? null })),
            );
            for (const batch of chunk(links, 1000)) await tx.insert(conceptLinks).values(batch);
            const cols = analysis.concepts.flatMap((c) =>
              (c.schema?.columns ?? []).map((col) => ({ versionId: version.id, conceptId: c.id, format: c.schema!.format, ordinal: col.ordinal, name: col.name.slice(0, 500), dataType: col.dataType, mode: col.mode, description: col.description })),
            );
            for (const batch of chunk(cols, 1000)) await tx.insert(schemaColumns).values(batch);
            const finished = new Date();
            const [run] = await tx
              .insert(validationRuns)
              .values({
                versionId: version.id,
                specVersion: v.specVersion,
                validatorVersion: v.validatorVersion,
                valid: v.valid,
                errorCount: v.counts.errors,
                warningCount: v.counts.warnings,
                infoCount: v.counts.infos,
                suppressed: v.suppressed,
                startedAt: job.startedAt ?? finished,
                finishedAt: finished,
              })
              .returning();
            for (const batch of chunk(analysis.issues, 1000)) {
              await tx.insert(validationIssues).values(
                batch.map((i) => ({
                  runId: run!.id,
                  versionId: version.id,
                  layer: i.layer,
                  severity: i.severity,
                  code: i.code,
                  message: i.message.slice(0, 2000),
                  path: i.location.path,
                  line: i.location.line ?? null,
                  column: i.location.column ?? null,
                  field: i.field ?? null,
                })),
              );
            }
            await tx
              .update(datasetVersions)
              .set({
                status: v.valid ? 'VALIDATED' : 'FAILED',
                format: extracted.format,
                scanStatus,
                scanEngine: scanner.name === 'none' ? null : scanner.name,
                okfVersion: v.metadata.okfVersion,
                conceptCount: analysis.concepts.length,
                fileCount: analysis.files.length,
                totalBytes: analysis.profile.totalBytes,
                valid: v.valid,
                errorCount: v.counts.errors,
                warningCount: v.counts.warnings,
                infoCount: v.counts.infos,
                qualityScore: analysis.profile.qualityScore,
                profile: analysis.profile,
                fieldSchema: analysis.fieldSchema,
                metadata: { ...v.metadata, ignoredFiles: analysis.ignoredFiles.slice(0, 100), indexes: analysis.indexes.map((i) => ({ path: i.path, entries: i.entries.length })), logs: analysis.logs.map((l) => ({ path: l.path, groups: l.groups.slice(0, 20) })) },
                searchText: buildSearchText(analysis),
                failure: v.valid ? null : { code: 'OKF_NONCONFORMANT', message: `The bundle is not OKF-conformant: ${v.counts.errors} structural error(s). See the validation report.`, stage: 'validate' },
                processedAt: finished,
              })
              .where(eq(datasetVersions.id, version.id));
            await refreshDatasetStatus(tx, version.datasetId);
            await tx.insert(auditLogs).values({
              organizationId: orgId,
              actorType: 'system',
              action: v.valid ? 'version.validated' : 'version.failed',
              resourceType: 'dataset',
              resourceId: version.datasetId,
              metadata: { version: version.number, versionId: version.id, jobId: job.id, valid: v.valid, errors: v.counts.errors, warnings: v.counts.warnings, concepts: analysis.concepts.length },
            });
          }),
        );
        await ctx.progress('done', 100);
        return { valid: v.valid, concepts: analysis.concepts.length, files: analysis.files.length, errors: v.counts.errors, warnings: v.counts.warnings };
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
  };
}

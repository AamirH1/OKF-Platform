import { datasetVersions, eq, jobs, refreshDatasetStatus, requestJobCancel } from '@okf/db';
import { jobSchema } from '@okf/shared';
import { audit } from '../lib/audit';
import { notFound } from '../lib/errors';
import { authorizeDataset } from '../services/access';
import { jobDTO } from '../services/datasets';
import { errorResponses, type RoutePlugin, uuidParam } from '../types';

const routes: RoutePlugin = async (app, { deps }) => {
  const load = async (id: string) => {
    const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, id));
    // Jobs without a dataset (none today) are internal; never expose them.
    if (!job?.datasetId) throw notFound('Job');
    return job as typeof job & { datasetId: string };
  };

  app.get('/jobs/:id', { schema: { tags: ['jobs'], summary: 'Job status and progress', params: uuidParam, response: { 200: jobSchema, ...errorResponses } } }, async (req) => {
    const job = await load(req.params.id);
    await authorizeDataset(deps, req, job.datasetId, 'dataset:read_drafts').catch(() => {
      throw notFound('Job');
    });
    return jobDTO(job);
  });

  app.post(
    '/jobs/:id/cancel',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Cancel a queued or running job',
        description: 'Queued jobs stop immediately; running jobs stop at the next stage boundary. Cancelling ingestion marks the version FAILED.',
        params: uuidParam,
        response: { 200: jobSchema, ...errorResponses },
      },
    },
    async (req) => {
      const job = await load(req.params.id);
      const authz = await authorizeDataset(deps, req, job.datasetId, 'dataset:upload').catch((e: unknown) => {
        throw e instanceof Error && 'statusCode' in e && (e as { statusCode: number }).statusCode === 403 ? e : notFound('Job');
      });
      await deps.db.transaction(async (tx) => {
        const status = await requestJobCancel(tx, job.id);
        if (status === 'CANCELLED' && job.type === 'ingest_version' && job.versionId) {
          await tx
            .update(datasetVersions)
            .set({ status: 'FAILED', failure: { code: 'CANCELLED', message: 'Processing was cancelled.', stage: null }, processedAt: new Date() })
            .where(eq(datasetVersions.id, job.versionId));
          await refreshDatasetStatus(tx, job.datasetId);
        }
        await audit(tx, req, { action: 'job.cancel_requested', organizationId: authz.dataset.organizationId, resourceType: 'dataset', resourceId: job.datasetId, metadata: { jobId: job.id, type: job.type } });
      });
      const [fresh] = await deps.db.select().from(jobs).where(eq(jobs.id, job.id));
      return jobDTO(fresh!);
    },
  );
};

export default routes;

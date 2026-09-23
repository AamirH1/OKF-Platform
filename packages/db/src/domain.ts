import { sql } from 'drizzle-orm';
import type { Executor } from './client';

/**
 * Recompute a dataset's stored status, latest version and search text from its versions
 * (rules in docs/architecture.md §3). Call inside the transaction that changed them.
 *
 * Search text comes from the published version when there is one, so unpublished draft
 * content never surfaces in public search results or snippets.
 */
export async function refreshDatasetStatus(ex: Executor, datasetId: string): Promise<void> {
  await ex.execute(sql`
    UPDATE datasets d SET
      latest_version_id = (SELECT v.id FROM dataset_versions v WHERE v.dataset_id = d.id ORDER BY v.number DESC LIMIT 1),
      search_text = coalesce(
        (SELECT v.search_text FROM dataset_versions v WHERE v.id = d.published_version_id),
        (SELECT v.search_text FROM dataset_versions v WHERE v.dataset_id = d.id AND v.status IN ('VALIDATED', 'PUBLISHED') ORDER BY v.number DESC LIMIT 1),
        ''),
      status = (CASE
        WHEN d.archived_at IS NOT NULL THEN 'ARCHIVED'
        WHEN d.published_version_id IS NOT NULL THEN 'PUBLISHED'
        ELSE coalesce((
          SELECT CASE v.status WHEN 'PUBLISHED' THEN 'VALIDATED' ELSE v.status::text END
          FROM dataset_versions v WHERE v.dataset_id = d.id ORDER BY v.number DESC LIMIT 1
        ), 'DRAFT')
      END)::dataset_status,
      updated_at = now()
    WHERE d.id = ${datasetId}`);
}

/** Increment a per-day usage counter (views, queries, downloads, api_requests). */
export async function recordUsage(
  ex: Executor,
  datasetId: string,
  counter: 'views' | 'queries' | 'downloads' | 'api_requests',
): Promise<void> {
  const col = sql.identifier(counter);
  await ex.execute(sql`
    INSERT INTO dataset_usage_daily (dataset_id, day, ${col}) VALUES (${datasetId}, current_date, 1)
    ON CONFLICT (dataset_id, day) DO UPDATE SET ${col} = dataset_usage_daily.${col} + 1`);
}

import { type Database, type SQL, sql } from '@okf/db';
import type { DatasetStatus, Page, SearchHitDTO } from '@okf/shared';

/** Who is searching; visibility is enforced inside the query, before pagination. */
export interface Viewer {
  userId: string | null;
  /** For API keys: only this organization's memberships count, and grants are ignored. */
  restrictToOrgId: string | null;
}

export interface SearchParams {
  q: string;
  scope: 'datasets' | 'concepts';
  organizationId?: string;
  tag?: string;
  type?: string;
  status?: DatasetStatus;
  sort: 'relevance' | 'updated' | 'name';
  page: number;
  pageSize: number;
}

/** Search backend abstraction; an OpenSearch implementation can replace Postgres FTS later. */
export interface SearchProvider {
  search(viewer: Viewer, params: SearchParams): Promise<Page<SearchHitDTO>>;
}

/** Highlight markers used by ts_headline; the web app turns them into <mark> elements. */
export const HL_START = '\u0002';
export const HL_STOP = '\u0003';

/**
 * SQL predicate over alias `d` (datasets) selecting datasets the viewer may see.
 * Mirrors `datasetAccess()` in @okf/shared; the permissions matrix test and the search
 * integration test pin them to each other.
 */
export function visibleDatasetSql(viewer: Viewer): SQL {
  const publicPart = sql`(d.visibility = 'public' AND d.published_version_id IS NOT NULL)`;
  if (!viewer.userId) return sql`(d.deleted_at IS NULL AND ${publicPart})`;
  const orgFilter = viewer.restrictToOrgId ? sql`AND m.organization_id = ${viewer.restrictToOrgId}` : sql``;
  const member = sql`EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.organization_id = d.organization_id AND m.user_id = ${viewer.userId} ${orgFilter}
      AND (d.visibility <> 'private' OR m.role IN ('owner', 'admin') OR d.created_by = ${viewer.userId})
  )`;
  const grant = viewer.restrictToOrgId
    ? sql`FALSE`
    : sql`EXISTS (SELECT 1 FROM dataset_grants g WHERE g.dataset_id = d.id AND g.user_id = ${viewer.userId})`;
  return sql`(d.deleted_at IS NULL AND (${publicPart} OR ${member} OR ${grant}))`;
}

/** Whether the viewer sees drafts of dataset `d` (members and grantees), used to pick the searchable version. */
function seesDraftsSql(viewer: Viewer): SQL {
  if (!viewer.userId) return sql`FALSE`;
  const orgFilter = viewer.restrictToOrgId ? sql`AND m.organization_id = ${viewer.restrictToOrgId}` : sql``;
  return sql`(EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = d.organization_id AND m.user_id = ${viewer.userId} ${orgFilter})
    OR EXISTS (SELECT 1 FROM dataset_grants g WHERE g.dataset_id = d.id AND g.user_id = ${viewer.userId}))`;
}

interface HitRow extends Record<string, unknown> {
  dataset_id: string;
  dataset_name: string;
  dataset_slug: string;
  visibility: SearchHitDTO['dataset']['visibility'];
  status: DatasetStatus;
  org_id: string;
  org_name: string;
  org_slug: string;
  concept_id: string | null;
  concept_type: string | null;
  concept_title: string | null;
  snippet: string | null;
  rank: number;
  tags: string[] | null;
  updated_at: Date;
  total: number;
}

export class PostgresSearchProvider implements SearchProvider {
  constructor(private readonly db: Database) {}

  async search(viewer: Viewer, p: SearchParams): Promise<Page<SearchHitDTO>> {
    const q = p.q.trim();
    const tsq = sql`(websearch_to_tsquery('english', ${q}) || websearch_to_tsquery('simple', ${q}))`;
    const headlineOpts = `StartSel=${HL_START}, StopSel=${HL_STOP}, MaxWords=30, MinWords=10, MaxFragments=2`;
    const filters: SQL[] = [visibleDatasetSql(viewer)];
    if (p.organizationId) filters.push(sql`d.organization_id = ${p.organizationId}`);
    if (p.status) filters.push(sql`d.status = ${p.status}`);
    if (p.tag) filters.push(sql`EXISTS (SELECT 1 FROM dataset_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.dataset_id = d.id AND t.name = ${p.tag})`);
    const offset = (p.page - 1) * p.pageSize;
    const tagsSql = sql`(SELECT coalesce(array_agg(t.name ORDER BY t.name), '{}') FROM dataset_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.dataset_id = d.id)`;

    let rows: HitRow[];
    if (p.scope === 'datasets') {
      if (p.type) {
        filters.push(sql`EXISTS (SELECT 1 FROM concepts c WHERE c.version_id = coalesce(d.published_version_id, d.latest_version_id) AND c.type = ${p.type})`);
      }
      if (q) filters.push(sql`(d.search @@ ${tsq} OR d.name ILIKE ${`%${escapeLike(q)}%`})`);
      const rank = q ? sql`ts_rank_cd(d.search, ${tsq}, 32) + CASE WHEN d.name ILIKE ${`%${escapeLike(q)}%`} THEN 1 ELSE 0 END` : sql`0`;
      const order = p.sort === 'name' ? sql`d.name ASC` : p.sort === 'updated' || !q ? sql`d.updated_at DESC` : sql`rank DESC, d.updated_at DESC`;
      const snippet = q
        ? sql`ts_headline('english', coalesce(nullif(d.description, ''), left(d.search_text, 2000)), ${tsq}, ${headlineOpts})`
        : sql`left(d.description, 240)`;
      const result = await this.db.execute<HitRow>(sql`
        SELECT d.id AS dataset_id, d.name AS dataset_name, d.slug AS dataset_slug, d.visibility, d.status,
               o.id AS org_id, o.name AS org_name, o.slug AS org_slug,
               NULL AS concept_id, NULL AS concept_type, NULL AS concept_title,
               ${snippet} AS snippet, ${rank} AS rank, ${tagsSql} AS tags, d.updated_at,
               count(*) OVER () AS total
        FROM datasets d JOIN organizations o ON o.id = d.organization_id AND o.deleted_at IS NULL
        WHERE ${sql.join(filters, sql` AND `)}
        ORDER BY ${order}
        LIMIT ${p.pageSize} OFFSET ${offset}`);
      rows = result.rows;
    } else {
      // Concepts of the version the viewer should see: newest processed version for
      // members, the published version for everyone else.
      const versionSql = sql`CASE WHEN ${seesDraftsSql(viewer)}
        THEN (SELECT v.id FROM dataset_versions v WHERE v.dataset_id = d.id AND v.status IN ('VALIDATED', 'PUBLISHED') ORDER BY v.number DESC LIMIT 1)
        ELSE d.published_version_id END`;
      const cf: SQL[] = [];
      if (q) cf.push(sql`(c.search @@ ${tsq} OR c.concept_id ILIKE ${`%${escapeLike(q)}%`})`);
      if (p.type) cf.push(sql`c.type = ${p.type}`);
      const rank = q ? sql`ts_rank_cd(c.search, ${tsq}, 32)` : sql`0`;
      const order = p.sort === 'name' ? sql`c.title ASC` : p.sort === 'updated' || !q ? sql`d.updated_at DESC, c.concept_id` : sql`rank DESC, c.concept_id`;
      const snippet = q
        ? sql`ts_headline('english', coalesce(c.description, '') || ' ' || left(c.excerpt, 1500), ${tsq}, ${headlineOpts})`
        : sql`coalesce(c.description, left(c.excerpt, 240))`;
      const result = await this.db.execute<HitRow>(sql`
        SELECT d.id AS dataset_id, d.name AS dataset_name, d.slug AS dataset_slug, d.visibility, d.status,
               o.id AS org_id, o.name AS org_name, o.slug AS org_slug,
               c.concept_id, c.type AS concept_type, c.title AS concept_title,
               ${snippet} AS snippet, ${rank} AS rank, c.tags AS tags, d.updated_at,
               count(*) OVER () AS total
        FROM datasets d
        JOIN organizations o ON o.id = d.organization_id AND o.deleted_at IS NULL
        JOIN concepts c ON c.version_id = ${versionSql}
        WHERE ${sql.join([...filters, ...cf], sql` AND `)}
        ORDER BY ${order}
        LIMIT ${p.pageSize} OFFSET ${offset}`);
      rows = result.rows;
    }

    return {
      data: rows.map((r) => ({
        kind: r.concept_id ? 'concept' : 'dataset',
        dataset: {
          id: r.dataset_id,
          name: r.dataset_name,
          slug: r.dataset_slug,
          organization: { id: r.org_id, name: r.org_name, slug: r.org_slug },
          visibility: r.visibility,
          status: r.status,
        },
        concept: r.concept_id ? { conceptId: r.concept_id, type: r.concept_type ?? '', title: r.concept_title ?? r.concept_id } : null,
        snippet: r.snippet ?? '',
        rank: Number(r.rank),
        tags: r.tags ?? [],
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
      page: { page: p.page, pageSize: p.pageSize, total: rows[0] ? Number(rows[0].total) : 0 },
    };
  }
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

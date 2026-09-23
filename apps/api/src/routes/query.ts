import { z } from 'zod';
import { recordUsage } from '@okf/db';
import { columnDefs, QueryError, TABLE_NAMES } from '@okf/query';
import { queryResultSchema, sqlQuerySchema, structuredQuerySchema } from '@okf/shared';
import { audit } from '../lib/audit';
import { AppError } from '../lib/errors';
import { authorizeDataset } from '../services/access';
import { resolveVersion } from '../services/datasets';
import { errorResponses, type RoutePlugin } from '../types';

const idParam = z.object({ id: z.uuid() });
const shareQuery = z.object({ shareToken: z.string().optional() });

const routes: RoutePlugin = async (app, { deps }) => {
  const prepare = async (req: Parameters<typeof authorizeDataset>[1], id: string, version?: number) => {
    const authz = await authorizeDataset(deps, req, id, 'dataset:query');
    const v = await resolveVersion(deps, authz, version);
    if (v.status !== 'VALIDATED' && v.status !== 'PUBLISHED') {
      throw new AppError(409, 'NOT_QUERYABLE', `Version ${v.number} is ${v.status}; only processed versions can be queried.`);
    }
    return { authz, v, target: { versionId: v.id, organizationId: authz.dataset.organizationId } };
  };

  app.get(
    '/datasets/:id/query/tables',
    {
      schema: {
        tags: ['query'],
        summary: 'Queryable tables and columns',
        params: idParam,
        querystring: shareQuery,
        response: {
          200: z.object({ tables: z.array(z.object({ name: z.string(), columns: z.array(z.object({ name: z.string(), kind: z.string(), description: z.string() })) })) }),
          ...errorResponses,
        },
      },
    },
    async (req) => {
      await authorizeDataset(deps, req, req.params.id, 'dataset:query');
      return { tables: TABLE_NAMES.map((name) => ({ name, columns: columnDefs(name).map(({ name: n, kind, description }) => ({ name: n, kind, description })) })) };
    },
  );

  app.post(
    '/datasets/:id/query',
    {
      schema: {
        tags: ['query'],
        summary: 'Structured query: select columns, filter, search, sort, paginate',
        description: 'Compiled to parameterized SQL against a whitelist of tables/columns. Engine: DuckDB over the version\'s parquet artifacts.',
        params: idParam,
        querystring: shareQuery,
        body: structuredQuerySchema,
        response: { 200: queryResultSchema, ...errorResponses },
      },
    },
    async (req) => {
      const { authz, v, target } = await prepare(req, req.params.id, req.body.version);
      const b = req.body;
      try {
        const result = await deps.query.structured(target, {
          table: b.table,
          columns: b.columns,
          filters: b.filters,
          search: b.search,
          sort: b.sort,
          limit: b.pageSize,
          offset: (b.page - 1) * b.pageSize,
        });
        deps.metrics.queries.labels('structured', 'ok').inc();
        await recordUsage(deps.db, authz.dataset.id, 'queries');
        return { ...result, version: v.number };
      } catch (e) {
        deps.metrics.queries.labels('structured', e instanceof QueryError ? e.code.toLowerCase() : 'error').inc();
        throw e;
      }
    },
  );

  app.post(
    '/datasets/:id/query/sql',
    {
      schema: {
        tags: ['query'],
        summary: 'Read-only SQL over the version\'s tables',
        description:
          'Exactly one SELECT statement over `concepts`, `links` and `schema_columns`. The database is in-memory with file/network access disabled ' +
          'and configuration locked; results are row-capped and queries are interrupted after the time limit.',
        params: idParam,
        querystring: shareQuery,
        body: sqlQuerySchema,
        response: { 200: queryResultSchema, ...errorResponses },
      },
    },
    async (req) => {
      const { authz, v, target } = await prepare(req, req.params.id, req.body.version);
      try {
        const result = await deps.query.sql(target, req.body.sql, { maxRows: req.body.maxRows });
        deps.metrics.queries.labels('sql', 'ok').inc();
        await recordUsage(deps.db, authz.dataset.id, 'queries');
        await audit(deps.db, req, {
          action: 'query.sql',
          organizationId: authz.dataset.organizationId,
          resourceType: 'dataset',
          resourceId: authz.dataset.id,
          metadata: { version: v.number, sql: req.body.sql.slice(0, 2000), rows: result.rows.length, elapsedMs: result.elapsedMs },
        });
        return { ...result, version: v.number };
      } catch (e) {
        deps.metrics.queries.labels('sql', e instanceof QueryError ? e.code.toLowerCase() : 'error').inc();
        throw e;
      }
    },
  );
};

export default routes;

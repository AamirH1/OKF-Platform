import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ArtifactPaths,
  type ArtifactRows,
  compileStructured,
  type ConceptRow,
  DuckDbQueryEngine,
  QueryError,
  writeParquetArtifacts,
} from '../src';

const concept = (i: number, over: Partial<ConceptRow> = {}): ConceptRow => ({
  concept_id: `tables/t${String(i).padStart(3, '0')}`,
  path: `tables/t${i}.md`,
  type: i % 2 ? 'BigQuery Table' : 'Metric',
  title: `Table ${i}`,
  description: i === 7 ? 'Orders 100% shipped_fast' : `Description ${i}`,
  resource: null,
  tags: i % 3 === 0 ? ['sales', 'pii'] : ['sales'],
  status: 'stable',
  trust_tier: 'unverified',
  is_stale: i === 5,
  stale_after: null,
  generated_by: 'human:x',
  last_changed_at: '2026-01-01T00:00:00Z',
  verified_by: [],
  source_count: i,
  link_count: 0,
  broken_link_count: 0,
  word_count: 10 * i,
  bytes: 100,
  schema_column_count: 0,
  frontmatter_json: JSON.stringify({ type: 'x', n: i }),
  ...over,
});

let dir: string;
let paths: ArtifactPaths;
let engine: DuckDbQueryEngine;
const target = { versionId: 'v1', organizationId: 'o1' };
let secret: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'okf-query-'));
  secret = path.join(dir, 'secret.csv');
  await writeFile(secret, 'password\nhunter2\n');
  const rows: ArtifactRows = {
    concepts: Array.from({ length: 50 }, (_, i) => concept(i)),
    links: [{ source_concept_id: 'tables/t001', via: 'body', kind: 'concept', raw: '/tables/t002.md', target_path: 'tables/t002.md', target_concept_id: 'tables/t002', broken: false, line: 3 }],
    schema_columns: [{ concept_id: 'tables/t001', ordinal: 1, name: 'order_id', data_type: 'STRING', mode: null, description: 'Id' }],
  };
  paths = await writeParquetArtifacts(path.join(dir, 'v1'), rows);
  engine = new DuckDbQueryEngine({ loadArtifacts: async () => paths, timeoutMs: 1500, maxRows: 20, memoryLimit: '256MB', cacheEntries: 2 });
});

afterAll(async () => {
  await engine.close();
  await rm(dir, { recursive: true, force: true });
});

async function queryError(p: Promise<unknown>): Promise<QueryError> {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(QueryError);
  return e as QueryError;
}

describe('structured queries', () => {
  it('selects, filters, sorts and paginates with a total', async () => {
    const r = await engine.structured(target, {
      table: 'concepts',
      columns: ['concept_id', 'type', 'word_count'],
      filters: [{ column: 'type', op: 'eq', value: 'BigQuery Table' }, { column: 'word_count', op: 'gte', value: 100 }],
      sort: [{ column: 'word_count', direction: 'desc' }],
      limit: 5,
      offset: 5,
    });
    expect(r.total).toBe(20);
    expect(r.rows).toHaveLength(5);
    expect(r.columns.map((c) => c.name)).toEqual(['concept_id', 'type', 'word_count']);
    expect(r.rows[0]).toEqual({ concept_id: 'tables/t039', type: 'BigQuery Table', word_count: '390' });
  });

  it('supports list membership, null checks and escaped search', async () => {
    const pii = await engine.structured(target, { table: 'concepts', filters: [{ column: 'tags', op: 'has', value: 'pii' }], limit: 100, offset: 0 });
    expect(pii.total).toBe(17);
    const nulls = await engine.structured(target, { table: 'concepts', filters: [{ column: 'resource', op: 'is_null' }], limit: 1, offset: 0 });
    expect(nulls.total).toBe(50);
    // `%` and `_` are literals, not wildcards.
    const s = await engine.structured(target, { table: 'concepts', search: '100% shipped_', limit: 10, offset: 0 });
    expect(s.rows.map((r) => r.concept_id)).toEqual(['tables/t007']);
    const none = await engine.structured(target, { table: 'concepts', search: '1%0', limit: 10, offset: 0 });
    expect(none.total).toBe(0);
  });

  it('caps the page size', async () => {
    const r = await engine.structured(target, { table: 'concepts', limit: 10_000, offset: 0 });
    expect(r.rows).toHaveLength(20);
  });

  it('rejects unknown tables, columns and bad operators', () => {
    expect(() => compileStructured({ table: 'users' as never, limit: 1, offset: 0 }, 10)).toThrow(QueryError);
    expect(() => compileStructured({ table: 'concepts', columns: ['title; DROP TABLE x'], limit: 1, offset: 0 }, 10)).toThrow(/Unknown column/);
    expect(() => compileStructured({ table: 'concepts', filters: [{ column: 'tags', op: 'eq', value: 'x' }], limit: 1, offset: 0 }, 10)).toThrow(/has/);
    expect(() => compileStructured({ table: 'concepts', filters: [{ column: 'word_count', op: 'gt', value: 'abc' }], limit: 1, offset: 0 }, 10)).toThrow(/number/);
  });

  it('binds values as parameters', () => {
    const c = compileStructured({ table: 'concepts', filters: [{ column: 'title', op: 'eq', value: "x' OR 1=1 --" }], limit: 5, offset: 0 }, 10);
    expect(c.sql).not.toContain('OR 1=1');
    expect(c.params).toContain("x' OR 1=1 --");
  });
});

describe('SQL sandbox', () => {
  it('runs a read-only SELECT and truncates', async () => {
    const r = await engine.sql(target, 'SELECT type, count(*) AS n FROM concepts GROUP BY type ORDER BY type');
    expect(r.rows).toEqual([{ type: 'BigQuery Table', n: '25' }, { type: 'Metric', n: '25' }]);
    const big = await engine.sql(target, 'SELECT * FROM concepts');
    expect(big.rows).toHaveLength(20);
    expect(big.truncated).toBe(true);
    const joined = await engine.sql(target, 'SELECT c.title, s.name FROM concepts c JOIN schema_columns s USING (concept_id)');
    expect(joined.rows).toEqual([{ title: 'Table 1', name: 'order_id' }]);
  });

  it.each([
    ['DROP TABLE concepts', 'FORBIDDEN_STATEMENT'],
    ['CREATE TABLE x AS SELECT 1', 'FORBIDDEN_STATEMENT'],
    ['SELECT 1; SELECT 2', 'FORBIDDEN_STATEMENT'],
    ['SET enable_external_access = true', 'FORBIDDEN_STATEMENT'],
    ["ATTACH '/tmp/x.db' AS x", 'FORBIDDEN_STATEMENT'],
    ['INSTALL httpfs', 'FORBIDDEN_STATEMENT'],
    ['PRAGMA threads = 64', 'FORBIDDEN_STATEMENT'],
    ['EXPLAIN SELECT 1', 'FORBIDDEN_STATEMENT'],
    ['SELEC 1', 'INVALID_QUERY'],
  ])('rejects %s', async (sql, code) => {
    expect((await queryError(engine.sql(target, sql))).code).toBe(code);
  });

  it('rejects COPY (at prepare time, because file access is disabled)', async () => {
    expect(['FORBIDDEN_STATEMENT', 'INVALID_QUERY']).toContain((await queryError(engine.sql(target, "COPY concepts TO '/tmp/out.csv'"))).code);
  });

  it('allows table-valued pragmas, which DuckDB rewrites to read-only SELECTs', async () => {
    const r = await engine.sql(target, 'PRAGMA database_list');
    expect(r.rows.every((row) => row.file === null || row.file === '')).toBe(true);
  });

  it('cannot read local files or the network from a SELECT', async () => {
    for (const sql of [
      `SELECT * FROM read_csv('${secret}')`,
      `SELECT * FROM '${secret}'`,
      `SELECT * FROM read_parquet('${paths.concepts}')`,
      `SELECT * FROM glob('/etc/*')`,
      `SELECT * FROM read_text('/etc/hosts')`,
      `SELECT * FROM read_csv('https://example.com/x.csv')`,
    ]) {
      const e = await queryError(engine.sql(target, sql));
      expect(['EXECUTION_ERROR', 'INVALID_QUERY']).toContain(e.code);
      expect(e.message).not.toContain('hunter2');
      expect(e.message).not.toContain(dir);
    }
  });

  it('interrupts long-running queries', async () => {
    const e = await queryError(engine.sql(target, 'SELECT count(*) FROM range(100000000000) a'));
    expect(e.code).toBe('TIMEOUT');
    // The engine remains usable afterwards.
    expect((await engine.sql(target, 'SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
  });

  it('evicts least-recently-used versions', async () => {
    for (const v of ['v2', 'v3', 'v4']) await engine.sql({ versionId: v, organizationId: 'o1' }, 'SELECT 1');
    expect((await engine.sql(target, 'SELECT count(*) AS n FROM concepts')).rows[0]).toEqual({ n: '50' });
  });
});

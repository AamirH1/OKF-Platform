import { type DuckDBConnection, DuckDBInstance, type DuckDBValue, StatementType } from '@duckdb/node-api';
import { type ArtifactPaths, createTableSql, quoteIdent } from './artifacts';
import { type ColumnDef, TABLE_NAMES, TABLES, type TableName } from './tables';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export const FILTER_OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'starts_with', 'in', 'is_null', 'is_not_null', 'has'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface Filter {
  column: string;
  op: FilterOp;
  value?: string | number | boolean | (string | number)[] | null;
}

export interface StructuredQuery {
  table: TableName;
  columns?: string[];
  filters?: Filter[];
  /** Case-insensitive substring match across the table's searchable columns. */
  search?: string;
  sort?: { column: string; direction: 'asc' | 'desc' }[];
  limit: number;
  offset: number;
}

export interface QueryColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, Json>[];
  /** Total matching rows (structured queries only). */
  total: number | null;
  /** More rows existed than were returned (SQL queries only). */
  truncated: boolean;
  elapsedMs: number;
  engine: 'duckdb';
}

export interface QueryTarget {
  versionId: string;
  organizationId: string;
}

/** Storage-engine-agnostic query interface (ADR-0004). */
export interface QueryEngine {
  structured(target: QueryTarget, query: StructuredQuery): Promise<QueryResult>;
  sql(target: QueryTarget, sql: string, opts?: { maxRows?: number }): Promise<QueryResult>;
  close(): Promise<void>;
}

/** An invalid query. `message` is safe to show to users. */
export class QueryError extends Error {
  constructor(
    readonly code: 'INVALID_QUERY' | 'FORBIDDEN_STATEMENT' | 'TIMEOUT' | 'ARTIFACTS_MISSING' | 'EXECUTION_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

export interface DuckDbEngineOptions {
  /** Resolve local parquet paths for a version, downloading them if needed. */
  loadArtifacts: (target: QueryTarget) => Promise<ArtifactPaths>;
  timeoutMs: number;
  maxRows: number;
  memoryLimit: string;
  cacheEntries: number;
}

interface CacheEntry {
  instance: DuckDBInstance;
  ready: Promise<void>;
}

export class DuckDbQueryEngine implements QueryEngine {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly opts: DuckDbEngineOptions) {}

  /**
   * One in-memory database per (immutable) version. Parquet is loaded into tables, then
   * external access is disabled and configuration locked before any user SQL runs.
   */
  private async database(target: QueryTarget): Promise<DuckDBInstance> {
    const key = target.versionId;
    let entry = this.cache.get(key);
    if (entry) {
      // LRU: move to most-recent position.
      this.cache.delete(key);
      this.cache.set(key, entry);
    } else {
      const instancePromise = DuckDBInstance.create(':memory:', {
        threads: '2',
        memory_limit: this.opts.memoryLimit,
        autoinstall_known_extensions: 'false',
        autoload_known_extensions: 'false',
      });
      const ready = (async () => {
        const instance = await instancePromise;
        const paths = await this.opts.loadArtifacts(target);
        const conn = await instance.connect();
        try {
          for (const table of TABLE_NAMES) {
            await conn.run(createTableSql(table));
            await conn.run(`INSERT INTO ${quoteIdent(table)} SELECT * FROM read_parquet($1)`, [paths[table]]);
          }
          await conn.run('SET enable_external_access = false');
          await conn.run('SET lock_configuration = true');
        } finally {
          conn.closeSync();
        }
      })();
      entry = { instance: undefined as unknown as DuckDBInstance, ready };
      this.cache.set(key, entry);
      try {
        entry.instance = await instancePromise;
        await ready;
      } catch (e) {
        this.cache.delete(key);
        throw e instanceof QueryError ? e : new QueryError('ARTIFACTS_MISSING', 'Query data for this version is unavailable.');
      }
      this.evict();
      return entry.instance;
    }
    await entry.ready;
    return entry.instance;
  }

  private evict(): void {
    while (this.cache.size > this.opts.cacheEntries) {
      const oldest = this.cache.keys().next().value as string;
      const e = this.cache.get(oldest);
      this.cache.delete(oldest);
      // Close after in-flight queries on it settle.
      void e?.ready.finally(() => setTimeout(() => e.instance.closeSync(), 30_000).unref());
    }
  }

  private async withConnection<T>(target: QueryTarget, fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
    const instance = await this.database(target);
    const conn = await instance.connect();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      conn.interrupt();
    }, this.opts.timeoutMs);
    try {
      return await fn(conn);
    } catch (e) {
      if (timedOut) throw new QueryError('TIMEOUT', `Query exceeded the ${this.opts.timeoutMs} ms time limit.`);
      if (e instanceof QueryError) throw e;
      throw new QueryError('EXECUTION_ERROR', cleanDuckDbMessage(e));
    } finally {
      clearTimeout(timer);
      conn.closeSync();
    }
  }

  async structured(target: QueryTarget, q: StructuredQuery): Promise<QueryResult> {
    const started = performance.now();
    const compiled = compileStructured(q, this.opts.maxRows);
    return this.withConnection(target, async (conn) => {
      const reader = await conn.runAndReadAll(compiled.sql, compiled.params);
      const countReader = await conn.runAndReadAll(compiled.countSql, compiled.countParams);
      const total = Number(countReader.getRowsJson()[0]?.[0] ?? 0);
      return {
        columns: reader.columnNames().map((name, i) => ({ name, type: reader.columnTypes()[i]!.toString() })),
        rows: reader.getRowObjectsJson() as Record<string, Json>[],
        total,
        truncated: false,
        elapsedMs: Math.round(performance.now() - started),
        engine: 'duckdb',
      };
    });
  }

  async sql(target: QueryTarget, sql: string, opts: { maxRows?: number } = {}): Promise<QueryResult> {
    const started = performance.now();
    const maxRows = Math.min(opts.maxRows ?? this.opts.maxRows, this.opts.maxRows);
    if (sql.length > 20_000) throw new QueryError('INVALID_QUERY', 'Query text is too long (max 20000 characters).');
    return this.withConnection(target, async (conn) => {
      let extracted;
      try {
        extracted = await conn.extractStatements(sql);
      } catch (e) {
        throw new QueryError('INVALID_QUERY', cleanDuckDbMessage(e));
      }
      if (extracted.count !== 1) throw new QueryError('FORBIDDEN_STATEMENT', 'Exactly one SELECT statement is allowed.');
      let prepared;
      try {
        prepared = await extracted.prepare(0);
      } catch (e) {
        throw new QueryError('INVALID_QUERY', cleanDuckDbMessage(e));
      }
      if (prepared.statementType !== StatementType.SELECT) {
        throw new QueryError('FORBIDDEN_STATEMENT', 'Only read-only SELECT queries are allowed.');
      }
      const reader = await prepared.streamAndReadUntil(maxRows + 1);
      const rows = reader.getRowObjectsJson() as Record<string, Json>[];
      return {
        columns: reader.columnNames().map((name, i) => ({ name, type: reader.columnTypes()[i]!.toString() })),
        rows: rows.slice(0, maxRows),
        total: null,
        truncated: rows.length > maxRows,
        elapsedMs: Math.round(performance.now() - started),
        engine: 'duckdb',
      };
    });
  }

  async close(): Promise<void> {
    for (const e of this.cache.values()) {
      await e.ready.catch(() => undefined);
      e.instance?.closeSync();
    }
    this.cache.clear();
  }
}

function cleanDuckDbMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Strip internal file paths that DuckDB may echo back.
  return msg
    .replace(/'\/[^']*'/g, "'<path>'")
    .replace(/"\/[^"]*"/g, '"<path>"')
    .replace(/(^|[\s(=])\/(?:[\w.-]+\/)+[\w.-]*/g, '$1<path>')
    .split('\n')
    .slice(0, 3)
    .join(' ')
    .slice(0, 500);
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface CompiledQuery {
  sql: string;
  params: DuckDBValue[];
  countSql: string;
  countParams: DuckDBValue[];
}

/**
 * Compile a structured query to parameterized SQL. Identifiers come only from the
 * TABLES whitelist and values are always bound parameters, so there is no injection surface.
 */
export function compileStructured(q: StructuredQuery, maxRows: number): CompiledQuery {
  if (!TABLE_NAMES.includes(q.table)) throw new QueryError('INVALID_QUERY', `Unknown table "${q.table}".`);
  const defs = new Map((TABLES[q.table] as readonly ColumnDef[]).map((c) => [c.name, c]));
  const col = (name: string): ColumnDef => {
    const def = defs.get(name);
    if (!def) throw new QueryError('INVALID_QUERY', `Unknown column "${name}" in table ${q.table}.`);
    return def;
  };
  const selected = q.columns && q.columns.length > 0 ? q.columns.map((c) => col(c).name) : [...defs.keys()];
  const params: DuckDBValue[] = [];
  const p = (v: DuckDBValue) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  for (const f of q.filters ?? []) {
    const def = col(f.column);
    const c = quoteIdent(def.name);
    const scalar = (): DuckDBValue => {
      if (f.value === undefined || f.value === null || Array.isArray(f.value)) throw new QueryError('INVALID_QUERY', `Filter ${f.op} on ${f.column} needs a single value.`);
      if (def.kind === 'integer') {
        const n = Number(f.value);
        if (!Number.isFinite(n)) throw new QueryError('INVALID_QUERY', `Filter on ${f.column} needs a number.`);
        return BigInt(Math.trunc(n));
      }
      if (def.kind === 'boolean') return f.value === true || f.value === 'true';
      return String(f.value);
    };
    switch (f.op) {
      case 'eq':
      case 'neq':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        if (def.kind === 'string_list') throw new QueryError('INVALID_QUERY', `Use "has" to filter list column ${f.column}.`);
        const sym = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[f.op];
        where.push(`${c} ${sym} ${p(scalar())}`);
        break;
      }
      case 'contains':
      case 'starts_with': {
        if (def.kind !== 'string') throw new QueryError('INVALID_QUERY', `${f.op} applies to text columns only.`);
        const v = escapeLike(String(scalar()));
        where.push(`${c} ILIKE ${p(f.op === 'contains' ? `%${v}%` : `${v}%`)} ESCAPE '\\'`);
        break;
      }
      case 'in': {
        if (!Array.isArray(f.value) || f.value.length === 0 || f.value.length > 100) {
          throw new QueryError('INVALID_QUERY', `"in" needs 1–100 values.`);
        }
        const values = f.value.map((v) => (def.kind === 'integer' ? BigInt(Math.trunc(Number(v))) : String(v)));
        where.push(`${c} IN (${values.map((v) => p(v)).join(', ')})`);
        break;
      }
      case 'is_null':
        where.push(`${c} IS NULL`);
        break;
      case 'is_not_null':
        where.push(`${c} IS NOT NULL`);
        break;
      case 'has':
        if (def.kind !== 'string_list') throw new QueryError('INVALID_QUERY', `"has" applies to list columns only.`);
        where.push(`list_contains(${c}, ${p(String(scalar()))})`);
        break;
      default:
        throw new QueryError('INVALID_QUERY', `Unknown operator.`);
    }
  }
  if (q.search && q.search.trim()) {
    const term = p(`%${escapeLike(q.search.trim())}%`);
    const searchable = [...defs.values()].filter((d) => d.searchable).map((d) => `${quoteIdent(d.name)} ILIKE ${term} ESCAPE '\\'`);
    if (searchable.length > 0) where.push(`(${searchable.join(' OR ')})`);
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const order = (q.sort ?? []).map((s) => `${quoteIdent(col(s.column).name)} ${s.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);
  // Stable pagination: always end with a unique-ish tiebreaker.
  const tiebreak = defs.has('concept_id') ? quoteIdent('concept_id') : quoteIdent([...defs.keys()][0]!);
  const orderSql = ` ORDER BY ${[...order, tiebreak].join(', ')}`;
  const limit = Math.max(1, Math.min(q.limit, maxRows));
  const offset = Math.max(0, Math.floor(q.offset));
  const countParams = [...params];
  const sql = `SELECT ${selected.map(quoteIdent).join(', ')} FROM ${quoteIdent(q.table)}${whereSql}${orderSql} LIMIT ${p(BigInt(limit))} OFFSET ${p(BigInt(offset))}`;
  return { sql, params, countSql: `SELECT count(*) FROM ${quoteIdent(q.table)}${whereSql}`, countParams };
}


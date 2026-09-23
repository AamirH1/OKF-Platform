import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance, LIST, VARCHAR, type DuckDBAppender } from '@duckdb/node-api';
import { type ArtifactRows, type ColumnDef, DUCKDB_TYPES, TABLE_NAMES, TABLES, type TableName } from './tables';

export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function createTableSql(table: TableName): string {
  const cols = (TABLES[table] as readonly ColumnDef[]).map((c) => `${quoteIdent(c.name)} ${DUCKDB_TYPES[c.kind]}`);
  return `CREATE TABLE ${quoteIdent(table)} (${cols.join(', ')})`;
}

function appendValue(appender: DuckDBAppender, col: ColumnDef, value: unknown): void {
  if (value === null || value === undefined) {
    if (col.kind === 'string_list') appender.appendList([], LIST(VARCHAR));
    else if (col.kind === 'boolean') appender.appendBoolean(false);
    else appender.appendNull();
    return;
  }
  switch (col.kind) {
    case 'string':
      appender.appendVarchar(String(value));
      break;
    case 'integer':
      appender.appendBigInt(BigInt(Math.trunc(Number(value))));
      break;
    case 'boolean':
      appender.appendBoolean(Boolean(value));
      break;
    case 'string_list':
      appender.appendList((value as unknown[]).map(String), LIST(VARCHAR));
      break;
  }
}

export type ArtifactPaths = Record<TableName, string>;

/**
 * Materialize the queryable tables of one version as parquet files in `dir`.
 * Runs in an isolated in-memory DuckDB instance.
 */
export async function writeParquetArtifacts(dir: string, rows: ArtifactRows): Promise<ArtifactPaths> {
  await mkdir(dir, { recursive: true });
  const instance = await DuckDBInstance.create(':memory:', {
    threads: '2',
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
  });
  const conn = await instance.connect();
  const out = {} as ArtifactPaths;
  try {
    for (const table of TABLE_NAMES) {
      const cols = TABLES[table] as readonly ColumnDef[];
      await conn.run(createTableSql(table));
      const appender = await conn.createAppender(table);
      for (const row of rows[table] as Record<string, unknown>[]) {
        for (const col of cols) appendValue(appender, col, row[col.name]);
        appender.endRow();
      }
      appender.flushSync();
      appender.closeSync();
      const file = path.join(dir, `${table}.parquet`);
      await conn.run(`COPY ${quoteIdent(table)} TO ${quoteLiteral(file)} (FORMAT parquet, COMPRESSION zstd)`);
      out[table] = file;
    }
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  return out;
}

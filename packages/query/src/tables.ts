/**
 * Queryable tables materialized per dataset version (ADR-0004). These are platform
 * projections of OKF concepts, not OKF constructs themselves.
 */
export type ColumnKind = 'string' | 'integer' | 'boolean' | 'string_list';

export interface ColumnDef {
  name: string;
  kind: ColumnKind;
  description: string;
  /** Included in free-text `search` matching. */
  searchable?: boolean;
}

export const TABLES = {
  concepts: [
    { name: 'concept_id', kind: 'string', description: 'Concept ID: bundle path without .md (OKF §2).', searchable: true },
    { name: 'path', kind: 'string', description: 'File path within the bundle.' },
    { name: 'type', kind: 'string', description: 'OKF `type` (required).', searchable: true },
    { name: 'title', kind: 'string', description: 'OKF `title`, or derived from the filename.', searchable: true },
    { name: 'description', kind: 'string', description: 'OKF `description`.', searchable: true },
    { name: 'resource', kind: 'string', description: 'OKF `resource` URI.', searchable: true },
    { name: 'tags', kind: 'string_list', description: 'OKF `tags`.' },
    { name: 'status', kind: 'string', description: 'Lifecycle status (draft | stable | deprecated; default stable).' },
    { name: 'trust_tier', kind: 'string', description: 'Derived trust tier (OKF §5.3).' },
    { name: 'is_stale', kind: 'boolean', description: 'now >= stale_after at processing time (OKF §5.5).' },
    { name: 'stale_after', kind: 'string', description: 'OKF `stale_after` as written.' },
    { name: 'generated_by', kind: 'string', description: '`generated.by` actor.' },
    { name: 'last_changed_at', kind: 'string', description: '`generated.at` (or v0.1 `timestamp`).' },
    { name: 'verified_by', kind: 'string_list', description: '`verified[].by` actors.' },
    { name: 'source_count', kind: 'integer', description: 'Number of `sources` entries.' },
    { name: 'link_count', kind: 'integer', description: 'Outbound links (body + path-valued frontmatter).' },
    { name: 'broken_link_count', kind: 'integer', description: 'Outbound links whose target is missing.' },
    { name: 'word_count', kind: 'integer', description: 'Words in the markdown body.' },
    { name: 'bytes', kind: 'integer', description: 'File size in bytes.' },
    { name: 'schema_column_count', kind: 'integer', description: 'Columns parsed from a `# Schema` section.' },
    { name: 'frontmatter_json', kind: 'string', description: 'Complete frontmatter as JSON text.' },
  ],
  links: [
    { name: 'source_concept_id', kind: 'string', description: 'Linking concept.', searchable: true },
    { name: 'via', kind: 'string', description: '`body` or the frontmatter field path.' },
    { name: 'kind', kind: 'string', description: 'concept | index | log | file | directory | external.' },
    { name: 'raw', kind: 'string', description: 'Link target as written.', searchable: true },
    { name: 'target_path', kind: 'string', description: 'Resolved bundle path.' },
    { name: 'target_concept_id', kind: 'string', description: 'Target concept ID, when it exists.', searchable: true },
    { name: 'broken', kind: 'boolean', description: 'Target missing (tolerated per OKF §6.1).' },
    { name: 'line', kind: 'integer', description: 'Line number in the source file.' },
  ],
  schema_columns: [
    { name: 'concept_id', kind: 'string', description: 'Concept whose `# Schema` defines the column.', searchable: true },
    { name: 'ordinal', kind: 'integer', description: 'Position in the schema.' },
    { name: 'name', kind: 'string', description: 'Column name.', searchable: true },
    { name: 'data_type', kind: 'string', description: 'Declared type, as written by the producer.', searchable: true },
    { name: 'mode', kind: 'string', description: 'Mode column when present (e.g. NULLABLE).' },
    { name: 'description', kind: 'string', description: 'Column description.', searchable: true },
  ],
} as const satisfies Record<string, readonly ColumnDef[]>;

export type TableName = keyof typeof TABLES;
export const TABLE_NAMES = Object.keys(TABLES) as TableName[];

type RowOf<T extends readonly ColumnDef[]> = {
  [C in T[number] as C['name']]: C['kind'] extends 'integer'
    ? number | null
    : C['kind'] extends 'boolean'
      ? boolean
      : C['kind'] extends 'string_list'
        ? string[]
        : string | null;
};

export type ConceptRow = RowOf<(typeof TABLES)['concepts']>;
export type LinkRow = RowOf<(typeof TABLES)['links']>;
export type SchemaColumnRow = RowOf<(typeof TABLES)['schema_columns']>;

export interface ArtifactRows {
  concepts: ConceptRow[];
  links: LinkRow[];
  schema_columns: SchemaColumnRow[];
}

export const DUCKDB_TYPES: Record<ColumnKind, string> = {
  string: 'VARCHAR',
  integer: 'BIGINT',
  boolean: 'BOOLEAN',
  string_list: 'VARCHAR[]',
};

export function columnDefs(table: TableName): readonly ColumnDef[] {
  return TABLES[table];
}

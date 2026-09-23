import type { BundleAnalysis, Concept } from '@okf/core';
import type { ArtifactRows } from '@okf/query';

/** Text indexed for catalog search: types, tags, titles, resources and schema column names. */
export function buildSearchText(a: BundleAnalysis, maxChars = 200_000): string {
  const parts = new Set<string>();
  for (const t of a.profile.types) parts.add(t.value);
  for (const t of a.profile.tags) parts.add(t.value);
  for (const c of a.concepts) {
    parts.add(c.title);
    if (c.resource) parts.add(c.resource);
    for (const col of c.schema?.columns ?? []) parts.add(col.name);
  }
  let out = '';
  for (const p of parts) {
    if (out.length + p.length + 1 > maxChars) break;
    out += `${p}\n`;
  }
  return out;
}

export function conceptRowValues(c: Concept) {
  return {
    conceptId: c.id,
    path: c.path,
    type: c.type,
    title: c.title,
    titleDerived: c.titleDerived,
    description: c.description,
    resource: c.resource,
    tags: c.tags,
    status: c.status,
    trustTier: c.trustTier,
    isStale: c.isStale,
    staleAfter: c.staleAfter,
    generatedBy: c.generated?.by || null,
    lastChangedAt: c.lastChangedAt,
    verifiedBy: c.verified.map((v) => v.by),
    sourceCount: c.sources.length,
    linkCount: c.links.filter((l) => l.kind !== 'external').length,
    brokenLinkCount: c.links.filter((l) => l.broken).length,
    wordCount: c.wordCount,
    bytes: c.bytes,
    sha256: c.sha256,
    frontmatter: c.frontmatter,
    headings: c.headings,
    sources: c.sources,
    computation: c.computation,
    excerpt: c.excerpt,
  };
}

/** Rows for the DuckDB parquet artifacts (packages/query/src/tables.ts). */
export function artifactRows(a: BundleAnalysis): ArtifactRows {
  return {
    concepts: a.concepts.map((c) => ({
      concept_id: c.id,
      path: c.path,
      type: c.type,
      title: c.title,
      description: c.description,
      resource: c.resource,
      tags: c.tags,
      status: c.status,
      trust_tier: c.trustTier,
      is_stale: c.isStale,
      stale_after: c.staleAfter,
      generated_by: c.generated?.by || null,
      last_changed_at: c.lastChangedAt,
      verified_by: c.verified.map((v) => v.by),
      source_count: c.sources.length,
      link_count: c.links.filter((l) => l.kind !== 'external').length,
      broken_link_count: c.links.filter((l) => l.broken).length,
      word_count: c.wordCount,
      bytes: c.bytes,
      schema_column_count: c.schema?.columns.length ?? 0,
      frontmatter_json: JSON.stringify(c.frontmatter),
    })),
    links: a.concepts.flatMap((c) =>
      c.links.map((l) => ({
        source_concept_id: c.id,
        via: l.via,
        kind: l.kind,
        raw: l.raw,
        target_path: l.targetPath,
        target_concept_id: l.targetConceptId,
        broken: l.broken,
        line: l.line,
      })),
    ),
    schema_columns: a.concepts.flatMap((c) =>
      (c.schema?.columns ?? []).map((col) => ({
        concept_id: c.id,
        ordinal: col.ordinal,
        name: col.name,
        data_type: col.dataType,
        mode: col.mode,
        description: col.description,
      })),
    ),
  };
}

export function contentTypeFor(p: string): string {
  const lower = p.toLowerCase();
  if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.sql') || lower.endsWith('.py') || lower.endsWith('.txt') || lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

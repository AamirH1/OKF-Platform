import type { BundleProfile, FieldSchemaEntry } from './profile';
import type { JsonValue } from './types';

/** Minimal per-concept data needed to diff two versions (loadable from the database). */
export interface ConceptSnapshot {
  id: string;
  type: string;
  title: string;
  sha256: string;
  frontmatter: Record<string, JsonValue>;
  schemaColumns: { name: string; dataType: string | null }[] | null;
}

export interface VersionSnapshot {
  concepts: ConceptSnapshot[];
  fieldSchema: FieldSchemaEntry[];
  profile: BundleProfile;
}

export interface FrontmatterChange {
  key: string;
  change: 'added' | 'removed' | 'changed';
  before?: JsonValue;
  after?: JsonValue;
}

export interface ConceptRef {
  id: string;
  type: string;
  title: string;
}

export interface ModifiedConcept extends ConceptRef {
  frontmatterChanges: FrontmatterChange[];
  /** File bytes differ but frontmatter is equal ⇒ the markdown body changed. */
  bodyChanged: boolean;
  typeChanged: { before: string; after: string } | null;
}

export interface AssetSchemaDiff {
  conceptId: string;
  status: 'added' | 'removed' | 'changed';
  addedColumns: { name: string; dataType: string | null }[];
  removedColumns: { name: string; dataType: string | null }[];
  typeChanges: { name: string; before: string | null; after: string | null }[];
}

export interface NumberDelta {
  before: number;
  after: number;
  delta: number;
}

export interface BundleDiff {
  /**
   * Exact comparisons: computed from every concept of both versions (content hashes,
   * frontmatter values, parsed `# Schema` columns). Nothing is sampled or estimated.
   */
  exact: {
    concepts: {
      added: ConceptRef[];
      removed: ConceptRef[];
      modified: ModifiedConcept[];
      unchangedCount: number;
    };
    assetSchemas: AssetSchemaDiff[];
    fieldSchema: {
      addedFields: string[];
      removedFields: string[];
      kindChanges: { field: string; before: string[]; after: string[] }[];
    };
  };
  /**
   * Aggregate statistics: deltas of whole-version summary metrics. Each number is exact for
   * its version, but a delta describes the distribution, not which concepts changed; e.g.
   * a zero delta in stale count can hide one concept becoming stale and another fresh.
   */
  statistical: {
    conceptCount: NumberDelta;
    totalBytes: NumberDelta;
    staleCount: NumberDelta;
    brokenLinks: NumberDelta;
    qualityScore: NumberDelta;
    types: { value: string; before: number; after: number; delta: number }[];
    trustTiers: { tier: string; before: number; after: number; delta: number }[];
    fieldPresence: { field: string; beforePct: number; afterPct: number; deltaPct: number }[];
  };
  summary: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
    schemaChanges: number;
    breaking: boolean;
  };
}

function stable(v: JsonValue | undefined): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

export function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return stable(a) === stable(b);
}

export function diffFrontmatter(before: Record<string, JsonValue>, after: Record<string, JsonValue>): FrontmatterChange[] {
  const changes: FrontmatterChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const inB = Object.hasOwn(before, key);
    const inA = Object.hasOwn(after, key);
    if (inB && !inA) changes.push({ key, change: 'removed', before: before[key] });
    else if (!inB && inA) changes.push({ key, change: 'added', after: after[key] });
    else if (!deepEqual(before[key], after[key])) {
      changes.push({ key, change: 'changed', before: before[key], after: after[key] });
    }
  }
  return changes;
}

const norm = (t: string | null) => (t ? t.trim().toUpperCase() : null);

export function diffColumns(
  conceptId: string,
  before: ConceptSnapshot['schemaColumns'],
  after: ConceptSnapshot['schemaColumns'],
): AssetSchemaDiff | null {
  if (!before && !after) return null;
  const b = new Map((before ?? []).map((c) => [c.name, c]));
  const a = new Map((after ?? []).map((c) => [c.name, c]));
  const diff: AssetSchemaDiff = {
    conceptId,
    status: !before ? 'added' : !after ? 'removed' : 'changed',
    addedColumns: [...a.values()].filter((c) => !b.has(c.name)),
    removedColumns: [...b.values()].filter((c) => !a.has(c.name)),
    typeChanges: [],
  };
  for (const [name, col] of a) {
    const prev = b.get(name);
    if (prev && norm(prev.dataType) !== norm(col.dataType)) {
      diff.typeChanges.push({ name, before: prev.dataType, after: col.dataType });
    }
  }
  const changed = diff.addedColumns.length + diff.removedColumns.length + diff.typeChanges.length > 0;
  return changed ? diff : null;
}

const delta = (before: number, after: number): NumberDelta => ({ before, after, delta: Math.round((after - before) * 100) / 100 });

function countDeltas(before: { value: string; count: number }[], after: { value: string; count: number }[]) {
  const b = new Map(before.map((x) => [x.value, x.count]));
  const a = new Map(after.map((x) => [x.value, x.count]));
  return [...new Set([...b.keys(), ...a.keys()])]
    .map((value) => ({ value, before: b.get(value) ?? 0, after: a.get(value) ?? 0, delta: (a.get(value) ?? 0) - (b.get(value) ?? 0) }))
    .filter((x) => x.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/**
 * Compare two versions. Concepts are matched by concept ID (file path); a renamed file
 * therefore appears as one removal plus one addition — OKF has no stable identity beyond path.
 */
export function diffVersions(base: VersionSnapshot, target: VersionSnapshot): BundleDiff {
  const b = new Map(base.concepts.map((c) => [c.id, c]));
  const t = new Map(target.concepts.map((c) => [c.id, c]));
  const ref = (c: ConceptSnapshot): ConceptRef => ({ id: c.id, type: c.type, title: c.title });

  const added = target.concepts.filter((c) => !b.has(c.id)).map(ref);
  const removed = base.concepts.filter((c) => !t.has(c.id)).map(ref);
  const modified: ModifiedConcept[] = [];
  const assetSchemas: AssetSchemaDiff[] = [];
  let unchanged = 0;

  for (const after of target.concepts) {
    const before = b.get(after.id);
    const sd = diffColumns(after.id, before?.schemaColumns ?? null, after.schemaColumns);
    if (sd) assetSchemas.push(sd);
    if (!before) continue;
    if (before.sha256 === after.sha256) {
      unchanged++;
      continue;
    }
    const fmChanges = diffFrontmatter(before.frontmatter, after.frontmatter);
    modified.push({
      ...ref(after),
      frontmatterChanges: fmChanges,
      bodyChanged: fmChanges.length === 0,
      typeChanged: before.type !== after.type ? { before: before.type, after: after.type } : null,
    });
  }
  for (const before of base.concepts) {
    if (!t.has(before.id)) {
      const sd = diffColumns(before.id, before.schemaColumns, null);
      if (sd) assetSchemas.push(sd);
    }
  }

  const bf = new Map(base.fieldSchema.map((f) => [f.name, f]));
  const tf = new Map(target.fieldSchema.map((f) => [f.name, f]));
  const kindChanges = [...tf.values()]
    .filter((f) => bf.has(f.name) && stable([...bf.get(f.name)!.kinds].sort()) !== stable([...f.kinds].sort()))
    .map((f) => ({ field: f.name, before: bf.get(f.name)!.kinds, after: f.kinds }));

  const bp = base.profile;
  const tp = target.profile;
  const tiers = ['unverified', 'machine-confirmed', 'human-reviewed'] as const;
  const fieldNames = [...new Set([...bf.keys(), ...tf.keys()])];

  const breaking =
    removed.length > 0 ||
    assetSchemas.some((s) => s.removedColumns.length > 0 || s.typeChanges.length > 0 || s.status === 'removed') ||
    modified.some((m) => m.typeChanged !== null);

  return {
    exact: {
      concepts: { added, removed, modified, unchangedCount: unchanged },
      assetSchemas,
      fieldSchema: {
        addedFields: [...tf.keys()].filter((k) => !bf.has(k)),
        removedFields: [...bf.keys()].filter((k) => !tf.has(k)),
        kindChanges,
      },
    },
    statistical: {
      conceptCount: delta(bp.conceptCount, tp.conceptCount),
      totalBytes: delta(bp.totalBytes, tp.totalBytes),
      staleCount: delta(bp.staleCount, tp.staleCount),
      brokenLinks: delta(bp.links.broken, tp.links.broken),
      qualityScore: delta(bp.qualityScore, tp.qualityScore),
      types: countDeltas(bp.types, tp.types),
      trustTiers: tiers
        .map((tier) => ({ tier, before: bp.trustTiers[tier], after: tp.trustTiers[tier], delta: tp.trustTiers[tier] - bp.trustTiers[tier] }))
        .filter((x) => x.delta !== 0),
      fieldPresence: fieldNames
        .map((field) => {
          const beforePct = bf.get(field)?.presentPct ?? 0;
          const afterPct = tf.get(field)?.presentPct ?? 0;
          return { field, beforePct, afterPct, deltaPct: Math.round((afterPct - beforePct) * 100) / 100 };
        })
        .filter((x) => x.deltaPct !== 0),
    },
    summary: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      unchanged,
      schemaChanges: assetSchemas.length,
      breaking,
    },
  };
}

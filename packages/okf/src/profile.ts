import { isIsoWithOffset } from './concept';
import type { Concept, JsonValue } from './types';

export type FieldFamily =
  | 'core'
  | 'provenance'
  | 'trust'
  | 'lifecycle'
  | 'computation'
  | 'legacy'
  | 'extension';

/** Frontmatter keys defined by OKF v0.2 (§4.1, §5, §10) plus v0.1 legacy `timestamp`. */
export const SPEC_FIELDS: Record<string, FieldFamily> = {
  type: 'core',
  title: 'core',
  description: 'core',
  resource: 'core',
  tags: 'core',
  sources: 'provenance',
  usage_window: 'provenance',
  generated: 'trust',
  verified: 'trust',
  status: 'lifecycle',
  stale_after: 'lifecycle',
  runtime: 'computation',
  parameters: 'computation',
  computation: 'computation',
  executor: 'computation',
  attester: 'computation',
  timestamp: 'legacy',
};

export type JsonKind = 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export function jsonKind(v: JsonValue): JsonKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v as 'string' | 'boolean' | 'object';
}

export interface ValueCount {
  value: string;
  count: number;
}

/** Inferred frontmatter field schema (platform-derived, not an OKF construct). */
export interface FieldSchemaEntry {
  name: string;
  family: FieldFamily;
  specDefined: boolean;
  /** Required by the OKF spec (only `type`). */
  specRequired: boolean;
  /** Observed JSON kinds, most common first. */
  kinds: JsonKind[];
  presentCount: number;
  presentPct: number;
}

export interface FieldProfile extends FieldSchemaEntry {
  kindCounts: Partial<Record<JsonKind, number>>;
  /** Concepts where the key is absent or explicitly null. */
  nullCount: number;
  nullPct: number;
  /** Exact distinct count of scalar values (array elements counted individually). */
  distinctCount: number;
  /** True when distinct tracking hit its cap; `distinctCount` is then a lower bound. */
  distinctCapped: boolean;
  topValues: ValueCount[];
  min: string | number | null;
  max: string | number | null;
  minLength: number | null;
  maxLength: number | null;
}

export interface NumericSummary {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  sum: number;
}

export interface BundleProfile {
  conceptCount: number;
  indexFileCount: number;
  logFileCount: number;
  otherFileCount: number;
  ignoredFileCount: number;
  totalBytes: number;
  markdownBytes: number;
  types: ValueCount[];
  trustTiers: Record<'unverified' | 'machine-confirmed' | 'human-reviewed', number>;
  statuses: Record<'draft' | 'stable' | 'deprecated', number>;
  staleCount: number;
  withStaleAfterCount: number;
  tags: ValueCount[];
  distinctTagCount: number;
  links: {
    total: number;
    internal: number;
    external: number;
    broken: number;
    conceptsWithoutInbound: number;
    conceptsWithoutOutbound: number;
  };
  words: NumericSummary | null;
  conceptBytes: NumericSummary | null;
  assetSchemas: { conceptsWithSchema: number; totalColumns: number; dataTypes: ValueCount[] };
  computations: { count: number; runtimes: ValueCount[] };
  /** Share of concepts carrying each recommended/optional field family. */
  coverage: {
    title: number;
    description: number;
    resource: number;
    tags: number;
    sources: number;
    generated: number;
    verified: number;
  };
  /** 0–100 platform heuristic (not an OKF concept); see `qualityScore`. */
  qualityScore: number;
  fields: FieldProfile[];
}

const TOP_N = 20;
const DISTINCT_CAP = 10_000;

export function summarize(values: number[]): NumericSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: Math.round((sum / sorted.length) * 100) / 100,
    p50: q(0.5),
    p90: q(0.9),
    sum,
  };
}

export function topCounts(counts: Map<string, number>, n = TOP_N): ValueCount[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

/** Math.min/max over large arrays without spreading onto the call stack. */
const minOf = (xs: number[]) => xs.reduce((a, b) => (b < a ? b : a), Infinity);
const maxOf = (xs: number[]) => xs.reduce((a, b) => (b > a ? b : a), -Infinity);

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 10_000) / 100);

function inc(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Exact per-field statistics over concept frontmatter. */
export function profileFields(concepts: Concept[]): FieldProfile[] {
  const n = concepts.length;
  interface Acc {
    present: number;
    nulls: number;
    kinds: Map<JsonKind, number>;
    values: Map<string, number>;
    capped: boolean;
    nums: number[];
    times: number[];
    timeStrs: Map<number, string>;
    lengths: number[];
  }
  const accs = new Map<string, Acc>();
  const order: string[] = [];
  for (const c of concepts) {
    for (const [key, value] of Object.entries(c.frontmatter)) {
      let acc = accs.get(key);
      if (!acc) {
        acc = { present: 0, nulls: 0, kinds: new Map(), values: new Map(), capped: false, nums: [], times: [], timeStrs: new Map(), lengths: [] };
        accs.set(key, acc);
        order.push(key);
      }
      acc.present++;
      const kind = jsonKind(value);
      acc.kinds.set(kind, (acc.kinds.get(kind) ?? 0) + 1);
      if (value === null) acc.nulls++;
      const scalars = Array.isArray(value) ? value.filter((v) => v === null || typeof v !== 'object') : [value];
      for (const s of scalars) {
        if (s === null || typeof s === 'object') continue;
        const key2 = String(s);
        if (acc.values.has(key2) || acc.values.size < DISTINCT_CAP) inc(acc.values, key2);
        else acc.capped = true;
        if (typeof s === 'number') acc.nums.push(s);
        if (typeof s === 'string') {
          acc.lengths.push(s.length);
          if (isIsoWithOffset(s)) {
            const t = Date.parse(s);
            acc.times.push(t);
            acc.timeStrs.set(t, s);
          }
        }
      }
    }
  }
  return order.map((name) => {
    const a = accs.get(name)!;
    const kinds = [...a.kinds.entries()].sort((x, y) => y[1] - x[1]);
    const family = SPEC_FIELDS[name] ?? 'extension';
    let min: string | number | null = null;
    let max: string | number | null = null;
    if (a.nums.length > 0) {
      min = minOf(a.nums);
      max = maxOf(a.nums);
    } else if (a.times.length > 0 && a.times.length === a.lengths.length) {
      min = a.timeStrs.get(minOf(a.times)) ?? null;
      max = a.timeStrs.get(maxOf(a.times)) ?? null;
    }
    const absent = n - a.present;
    return {
      name,
      family,
      specDefined: family !== 'extension',
      specRequired: name === 'type',
      kinds: kinds.map(([k]) => k),
      kindCounts: Object.fromEntries(kinds),
      presentCount: a.present,
      presentPct: pct(a.present, n),
      nullCount: absent + a.nulls,
      nullPct: pct(absent + a.nulls, n),
      distinctCount: a.values.size,
      distinctCapped: a.capped,
      topValues: topCounts(a.values),
      min,
      max,
      minLength: a.lengths.length ? minOf(a.lengths) : null,
      maxLength: a.lengths.length ? maxOf(a.lengths) : null,
    };
  });
}

export function fieldSchemaFrom(fields: FieldProfile[]): FieldSchemaEntry[] {
  return fields.map(({ name, family, specDefined, specRequired, kinds, presentCount, presentPct }) => ({
    name,
    family,
    specDefined,
    specRequired,
    kinds,
    presentCount,
    presentPct,
  }));
}

/**
 * Platform quality heuristic, 0–100. Weighted share of concepts with a description (30),
 * explicit title (10), sources (20), verification (20), not stale (10) and no broken
 * outbound links (10). Documented in docs/architecture.md; not part of OKF.
 */
export function qualityScore(concepts: Concept[]): number {
  if (concepts.length === 0) return 0;
  const share = (f: (c: Concept) => boolean) => concepts.filter(f).length / concepts.length;
  const score =
    30 * share((c) => !!c.description) +
    10 * share((c) => !c.titleDerived) +
    20 * share((c) => c.sources.length > 0) +
    20 * share((c) => c.verified.length > 0) +
    10 * share((c) => !c.isStale) +
    10 * share((c) => !c.links.some((l) => l.broken));
  return Math.round(score);
}

export interface ProfileInput {
  concepts: Concept[];
  indexFileCount: number;
  logFileCount: number;
  otherFileCount: number;
  ignoredFileCount: number;
  totalBytes: number;
  markdownBytes: number;
}

export function profileBundle(input: ProfileInput): BundleProfile {
  const { concepts } = input;
  const n = concepts.length;
  const types = new Map<string, number>();
  const tags = new Map<string, number>();
  const dataTypes = new Map<string, number>();
  const runtimes = new Map<string, number>();
  const trustTiers = { unverified: 0, 'machine-confirmed': 0, 'human-reviewed': 0 };
  const statuses = { draft: 0, stable: 0, deprecated: 0 };
  const inbound = new Map<string, number>();
  let internal = 0;
  let external = 0;
  let broken = 0;
  let schemaConcepts = 0;
  let schemaColumns = 0;
  let computations = 0;

  for (const c of concepts) {
    inc(types, c.type);
    for (const t of c.tags) inc(tags, t);
    trustTiers[c.trustTier]++;
    statuses[c.status]++;
    for (const l of c.links) {
      if (l.kind === 'external') external++;
      else if (l.kind !== 'anchor') internal++;
      if (l.broken) broken++;
      if (l.targetConceptId && l.targetConceptId !== c.id) inc(inbound, l.targetConceptId);
    }
    if (c.schema) {
      schemaConcepts++;
      schemaColumns += c.schema.columns.length;
      for (const col of c.schema.columns) inc(dataTypes, (col.dataType ?? 'unspecified').toUpperCase());
    }
    if (c.computation) {
      computations++;
      inc(runtimes, c.computation.runtime ?? 'unspecified');
    }
  }
  const has = (f: (c: Concept) => boolean) => pct(concepts.filter(f).length, n);
  return {
    conceptCount: n,
    indexFileCount: input.indexFileCount,
    logFileCount: input.logFileCount,
    otherFileCount: input.otherFileCount,
    ignoredFileCount: input.ignoredFileCount,
    totalBytes: input.totalBytes,
    markdownBytes: input.markdownBytes,
    types: topCounts(types, 100),
    trustTiers,
    statuses,
    staleCount: concepts.filter((c) => c.isStale).length,
    withStaleAfterCount: concepts.filter((c) => c.staleAfter !== null).length,
    tags: topCounts(tags, 50),
    distinctTagCount: tags.size,
    links: {
      total: internal + external,
      internal,
      external,
      broken,
      conceptsWithoutInbound: concepts.filter((c) => !inbound.has(c.id)).length,
      conceptsWithoutOutbound: concepts.filter((c) => !c.links.some((l) => l.targetConceptId)).length,
    },
    words: summarize(concepts.map((c) => c.wordCount)),
    conceptBytes: summarize(concepts.map((c) => c.bytes)),
    assetSchemas: { conceptsWithSchema: schemaConcepts, totalColumns: schemaColumns, dataTypes: topCounts(dataTypes, 30) },
    computations: { count: computations, runtimes: topCounts(runtimes) },
    coverage: {
      title: has((c) => !c.titleDerived),
      description: has((c) => !!c.description),
      resource: has((c) => !!c.resource),
      tags: has((c) => c.tags.length > 0),
      sources: has((c) => c.sources.length > 0),
      generated: has((c) => c.generated !== null),
      verified: has((c) => c.verified.length > 0),
    },
    qualityScore: qualityScore(concepts),
    fields: profileFields(concepts),
  };
}

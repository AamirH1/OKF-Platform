import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeBundle,
  DirectorySource,
  diffVersions,
  isConventionalActor,
  isIsoCalendarDate,
  isIsoWithOffset,
  parseFrontmatter,
  resolveLink,
  splitLeadingType,
  trustTier,
  type VersionSnapshot,
} from '../src';

describe('resolveLink (§6)', () => {
  it.each([
    ['tables/orders.md', '/tables/customers.md', { kind: 'internal', path: 'tables/customers.md', isDirectory: false }],
    ['tables/orders.md', '../metrics/revenue.md', { kind: 'internal', path: 'metrics/revenue.md', isDirectory: false }],
    ['tables/orders.md', './customers.md#joins', { kind: 'internal', path: 'tables/customers.md', isDirectory: false }],
    ['a.md', 'sub/', { kind: 'internal', path: 'sub', isDirectory: true }],
    ['a.md', 'caf%C3%A9.md', { kind: 'internal', path: 'café.md', isDirectory: false }],
    ['a.md', 'https://example.com/x.md', { kind: 'external' }],
    ['a.md', 'mailto:x@y.z', { kind: 'external' }],
    ['a.md', '#section', { kind: 'anchor' }],
    ['a.md', '../outside.md', { kind: 'escapes' }],
    ['x/y.md', '../../outside.md', { kind: 'escapes' }],
    ['x/y.md', '/../etc/passwd', { kind: 'escapes' }],
  ])('%s → %s', (from, raw, expected) => {
    expect(resolveLink(from, raw)).toEqual(expected);
  });
});

describe('splitLeadingType (list-format # Schema)', () => {
  it.each([
    ['INTEGER, Unique identifier.', 'INTEGER', 'Unique identifier.'],
    ['NUMERIC(18,4) - Amount', 'NUMERIC(18,4)', 'Amount'],
    ['ARRAY<STRUCT<key STRING, value INT64>>, Params', 'ARRAY<STRUCT<key STRING, value INT64>>', 'Params'],
    ['(STRING): Name', 'STRING', 'Name'],
    ['string, lower-case type', 'string', 'lower-case type'],
    ['TIMESTAMP', 'TIMESTAMP', ''],
    ['One of pending, paid', null, 'One of pending, paid'],
    ['A string value', null, 'A string value'],
  ])('%s', (text, type, rest) => {
    expect(splitLeadingType(text)).toEqual({ dataType: type, remainder: rest });
  });
});

describe('frontmatter parsing', () => {
  it('keeps ISO timestamps as strings and preserves key order', () => {
    const r = parseFrontmatter('---\nz: 1\ntype: T\nat: 2026-06-30T14:00:00Z\n---\n\nbody');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(Object.keys(r.data)).toEqual(['z', 'type', 'at']);
    expect(r.data.at).toBe('2026-06-30T14:00:00Z');
    expect(r.keyLines.type).toBe(3);
    expect(r.body).toBe('body');
    expect(r.bodyLine).toBe(7);
  });

  it('treats an empty block as an empty mapping', () => {
    const r = parseFrontmatter('---\n---\n');
    expect(r.kind === 'ok' && Object.keys(r.data)).toEqual([]);
  });

  it('converts non-finite numbers to JSON-safe strings', () => {
    const r = parseFrontmatter('---\ntype: T\nx: .inf\ny: .nan\n---\n');
    expect(r.kind === 'ok' && [r.data.x, r.data.y]).toEqual(['Infinity', 'NaN']);
  });

  it('does not execute or resolve language-specific tags', () => {
    const r = parseFrontmatter('---\ntype: T\nx: !!python/object:os.system ls\n---\n');
    expect(r.kind === 'ok' && r.data.x).toBe('ls');
  });
});

describe('conventions', () => {
  it('ISO 8601 with offset (§5)', () => {
    expect(isIsoWithOffset('2026-06-30T14:00:00Z')).toBe(true);
    expect(isIsoWithOffset('2026-06-30T14:00:00.123+05:30')).toBe(true);
    expect(isIsoWithOffset('2026-06-30T14:00:00')).toBe(false);
    expect(isIsoWithOffset('2026-06-30')).toBe(false);
    expect(isIsoCalendarDate('2026-02-29')).toBe(false);
    expect(isIsoCalendarDate('2028-02-29')).toBe(true);
  });

  it('actors (§7) and trust tiers (§5.3)', () => {
    expect(isConventionalActor('reference_agent/gemini-2.5-pro')).toBe(true);
    expect(isConventionalActor('human:ahormati')).toBe(true);
    expect(isConventionalActor('process:finance-nightly')).toBe(true);
    expect(isConventionalActor('Alice')).toBe(false);
    expect(trustTier([])).toBe('unverified');
    expect(trustTier([{ by: 'process:x', at: null }])).toBe('machine-confirmed');
    expect(trustTier([{ by: 'process:x', at: null }, { by: 'human:y', at: null }])).toBe('human-reviewed');
  });
});

describe('diffVersions', () => {
  const FIXTURES = path.resolve(import.meta.dirname, '../../../tests/fixtures/okf/schema-evolution');
  const snap = async (dir: string): Promise<VersionSnapshot> => {
    const a = await analyzeBundle(new DirectorySource(path.join(FIXTURES, dir)), { now: new Date('2026-09-01T00:00:00Z') });
    return {
      concepts: a.concepts.map((c) => ({
        id: c.id,
        type: c.type,
        title: c.title,
        sha256: c.sha256,
        frontmatter: c.frontmatter,
        schemaColumns: c.schema ? c.schema.columns.map((col) => ({ name: col.name, dataType: col.dataType })) : null,
      })),
      fieldSchema: a.fieldSchema,
      profile: a.profile,
    };
  };

  it('reports exact concept, schema and field changes', async () => {
    const d = diffVersions(await snap('v1'), await snap('v2'));
    expect(d.exact.concepts.added.map((c) => c.id)).toEqual(['tables/refunds']);
    expect(d.exact.concepts.removed.map((c) => c.id)).toEqual(['tables/returns']);
    const orders = d.exact.concepts.modified.find((m) => m.id === 'tables/orders')!;
    expect(orders.frontmatterChanges.map((c) => `${c.change}:${c.key}`).sort()).toEqual([
      'added:verified',
      'changed:description',
      'changed:generated',
      'changed:tags',
    ]);
    const overview = d.exact.concepts.modified.find((m) => m.id === 'overview')!;
    expect(overview.bodyChanged).toBe(true);
    expect(overview.frontmatterChanges).toEqual([]);

    const ordersSchema = d.exact.assetSchemas.find((s) => s.conceptId === 'tables/orders')!;
    expect(ordersSchema.addedColumns.map((c) => c.name)).toEqual(['currency', 'placed_at']);
    expect(ordersSchema.removedColumns.map((c) => c.name)).toEqual(['legacy_flag']);
    expect(ordersSchema.typeChanges).toEqual([{ name: 'amount', before: 'FLOAT64', after: 'NUMERIC(18,2)' }]);
    expect(d.exact.assetSchemas.find((s) => s.conceptId === 'tables/refunds')?.status).toBe('added');
    expect(d.exact.fieldSchema.addedFields).toEqual(['verified']);
    expect(d.summary).toMatchObject({ added: 1, removed: 1, modified: 2, unchanged: 0, breaking: true });
    expect(d.statistical.conceptCount).toEqual({ before: 3, after: 3, delta: 0 });
    expect(d.statistical.trustTiers).toEqual([
      { tier: 'unverified', before: 3, after: 2, delta: -1 },
      { tier: 'human-reviewed', before: 0, after: 1, delta: 1 },
    ]);
  });

  it('an identical version has no changes', async () => {
    const v = await snap('v1');
    const d = diffVersions(v, v);
    expect(d.summary).toMatchObject({ added: 0, removed: 0, modified: 0, unchanged: 3, breaking: false });
  });
});

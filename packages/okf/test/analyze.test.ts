import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeBundle, DirectorySource, MemorySource, type ValidationIssue } from '../src';

const FIXTURES = path.resolve(import.meta.dirname, '../../../tests/fixtures/okf');
const NOW = new Date('2026-09-23T00:00:00Z');
const analyze = (dir: string) => analyzeBundle(new DirectorySource(path.join(FIXTURES, dir)), { now: NOW });
const codes = (issues: ValidationIssue[]) => [...new Set(issues.map((i) => i.code))].sort();
const at = (issues: ValidationIssue[], code: string) => issues.filter((i) => i.code === code);

describe('analyzeBundle — Google sample bundles', () => {
  it('accepts acme_retail (exercises every v0.2 family) as conformant', async () => {
    const r = await analyze('acme_retail');
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.valid).toBe(true);
    expect(r.concepts).toHaveLength(9);
    const orders = r.concepts.find((c) => c.id === 'tables/orders')!;
    expect(orders.type).toBe('BigQuery Table');
    expect(orders.trustTier).toBe('human-reviewed');
    expect(orders.sources.map((s) => s.id)).toEqual(['warehouse-schema', 'revenue-policy']);
    expect(orders.schema?.format).toBe('table');
    expect(orders.schema?.columns.map((c) => c.name)).toContain('net_amount');
    expect(orders.schema?.columns.find((c) => c.name === 'gross_amount')?.dataType).toBe('NUMERIC(18,4)');
    // Timestamps stay strings exactly as authored (YAML 1.2 core schema).
    expect(orders.frontmatter.stale_after).toBe('2026-12-31T00:00:00Z');
    // sources[].resource `policies/revenue-recognition.md` resolves root-relative.
    const policyLink = orders.links.find((l) => l.via === 'sources[1].resource')!;
    expect(policyLink.broken).toBe(false);
    expect(policyLink.targetConceptId).toBe('policies/revenue-recognition');
  });

  it('parses Attested Computation contracts', async () => {
    const r = await analyze('acme_retail');
    const comp = r.concepts.find((c) => c.id === 'computations/revenue-ytd')!;
    expect(comp.computation?.runtime).toBe('bigquery');
    expect(comp.computation?.parameters[0]).toMatchObject({ name: 'year', type: 'integer', required: true });
    expect(comp.computation?.inlineLanguage).toBe('sql');
    expect(comp.computation?.receipt).toContain('job_id');
  });

  it('extracts list-format schemas from stackoverflow', async () => {
    const r = await analyze('stackoverflow');
    expect(r.validation.valid).toBe(true);
    const badges = r.concepts.find((c) => c.id.endsWith('badges'))!;
    expect(badges.schema?.format).toBe('list');
    expect(badges.schema?.columns[0]).toMatchObject({ name: 'id', dataType: 'INTEGER' });
    expect(badges.schema?.columns.find((c) => c.name === 'tag_based')?.dataType).toBe('BOOLEAN');
  });
});

describe('analyzeBundle — project fixtures', () => {
  it('valid-minimal is conformant with rich metadata', async () => {
    const r = await analyze('valid-minimal');
    expect(r.validation.valid).toBe(true);
    expect(r.validation.metadata.declaredOkfVersion).toBe('0.2');
    expect(r.concepts.map((c) => c.id).sort()).toEqual([
      'metrics/revenue',
      'playbooks/late-shipments',
      'tables/customers',
      'tables/orders',
    ]);
    expect(r.indexes).toHaveLength(4);
    expect(r.logs[0]?.groups.map((g) => g.date)).toEqual(['2026-08-02', '2026-07-15']);
    const customers = r.concepts.find((c) => c.id === 'tables/customers')!;
    expect(customers.trustTier).toBe('machine-confirmed');
    const orders = r.concepts.find((c) => c.id === 'tables/orders')!;
    expect(orders.links.filter((l) => l.kind === 'concept').map((l) => l.targetConceptId)).toEqual(
      expect.arrayContaining(['tables/customers', 'metrics/revenue']),
    );
    expect(r.profile.links.broken).toBe(0);
    expect(r.profile.trustTiers).toEqual({ unverified: 2, 'machine-confirmed': 1, 'human-reviewed': 1 });
    expect(r.profile.statuses.draft).toBe(1);
    const ext = r.profile.fields.find((f) => f.name === 'owner_team')!;
    expect(ext).toMatchObject({ family: 'extension', specDefined: false, presentCount: 1, nullPct: 75 });
    // No orphan: every concept is linked from an index.
    expect(at(r.issues, 'Q_ORPHAN_CONCEPT')).toEqual([]);
  });

  it('reports missing and empty type as structural errors with locations', async () => {
    const r = await analyze('invalid-missing-type');
    expect(r.validation.valid).toBe(false);
    const missing = at(r.validation.errors, 'OKF_MISSING_TYPE');
    expect(missing.map((i) => i.location.path).sort()).toEqual(['docs/empty-type.md', 'docs/no-type.md']);
    expect(missing[0]).toMatchObject({ layer: 'structural', severity: 'error', field: 'type' });
    expect(at(r.validation.errors, 'OKF_MISSING_FRONTMATTER')[0]?.location).toEqual({ path: 'docs/README.md', line: 1 });
    // Only the conformant concept is kept.
    expect(r.concepts.map((c) => c.id)).toEqual(['docs/good']);
  });

  it('classifies malformed frontmatter precisely and survives an alias bomb', async () => {
    const r = await analyze('malformed-metadata');
    expect(codes(r.validation.errors)).toEqual([
      'OKF_FRONTMATTER_NOT_MAPPING',
      'OKF_INVALID_YAML',
      'OKF_NOT_UTF8',
      'OKF_UNTERMINATED_FRONTMATTER',
    ]);
    const bad = at(r.validation.errors, 'OKF_INVALID_YAML');
    expect(bad.map((i) => i.location.path).sort()).toEqual(['alias-bomb.md', 'bad-yaml.md']);
    expect(bad.find((i) => i.location.path === 'bad-yaml.md')?.location.line).toBeGreaterThanOrEqual(2);
    expect(r.concepts.map((c) => c.id)).toEqual(['ok']);
  });

  it('enforces reserved-file structure (§8, §9)', async () => {
    const r = await analyze('invalid-reserved');
    const idx = at(r.validation.errors, 'OKF_INDEX_FRONTMATTER');
    expect(idx.map((i) => i.location.path).sort()).toEqual(['index.md', 'sub/index.md']);
    expect(idx.find((i) => i.location.path === 'index.md')?.field).toBe('title');
    const log = at(r.validation.errors, 'OKF_LOG_DATE_HEADING');
    expect(log.map((i) => i.message)).toEqual([
      expect.stringContaining('May 5, 2026'),
      expect.stringContaining('2026-02-30'),
    ]);
    expect(r.validation.valid).toBe(false);
  });

  it('edge cases are conformant; problems surface only as quality issues', async () => {
    const r = await analyze('edge-cases');
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.valid).toBe(true);
    const byId = new Map(r.concepts.map((c) => [c.id, c]));

    const bom = byId.get('bom-crlf')!;
    expect(bom.title).toBe('BOM and CRLF');
    expect(bom.links[0]).toMatchObject({ kind: 'concept', targetConceptId: 'unicode/café-métricas', broken: false });

    const uni = byId.get('unicode/café-métricas')!;
    expect(uni.type).toBe('Métrica');
    expect(uni.tags).toEqual(['ünïcödé', '数据']);
    expect(uni.links.find((l) => l.raw === '/does/not/exist.md')?.broken).toBe(true);

    const trust = byId.get('trust-edge')!;
    expect(trust.verified).toHaveLength(1); // bare mapping ⇒ one-element list (§5.2)
    expect(trust.trustTier).toBe('human-reviewed');
    expect(trust.status).toBe('stable'); // unknown status treated as stable
    expect(trust.isStale).toBe(false); // date-only stale_after ignored
    expect(trust.frontmatter.owner).toBe('second'); // duplicate key: last wins, like PyYAML

    const stale = byId.get('stale')!;
    expect(stale.isStale).toBe(true);
    expect(stale.titleDerived).toBe(true);
    expect(stale.title).toBe('Stale');
    expect(stale.links.find((l) => l.raw === 'dir-link/')).toMatchObject({ kind: 'directory', broken: false });

    expect(byId.get('legacy-v01')!.lastChangedAt).toBe('2026-05-28T14:30:00Z');
    expect(byId.get('type-only')).toBeDefined(); // a concept carrying only `type` is conformant

    const comp = byId.get('computation')!;
    expect(comp.computation?.runtime).toBe('postgres');
    expect(comp.computation?.parameters).toHaveLength(1);
    expect(comp.computation?.inlineCode).toContain('SELECT count(*)');

    expect(r.ignoredFiles.sort()).toEqual(['.git/HEAD', '__MACOSX/._stale.md']);
    expect(r.files.find((f) => f.path === 'notes.txt')?.kind).toBe('other');

    const q = codes(r.issues);
    for (const code of [
      'Q_BROKEN_LINK',
      'Q_LINK_ESCAPES_BUNDLE',
      'Q_STALE',
      'Q_STALE_AFTER_IGNORED',
      'Q_INVALID_STATUS',
      'Q_LEGACY_TIMESTAMP',
      'Q_LEGACY_CITATIONS',
      'Q_GENERATED_MISSING_BY',
      'Q_TIMESTAMP_FORMAT',
      'Q_SOURCE_MISSING_RESOURCE',
      'Q_SOURCE_DUPLICATE_ID',
      'Q_USAGE_COUNT_INVALID',
      'Q_UNRESOLVED_PATH_FIELD',
      'Q_COMPUTATION_MISSING_RUNTIME',
      'Q_COMPUTATION_MISSING',
      'Q_COMPUTATION_PARAMETERS_MALFORMED',
      'Q_MISSING_DESCRIPTION',
      'Q_IGNORED_FILES',
      'Q_NO_ROOT_INDEX',
    ]) {
      expect(q, code).toContain(code);
    }
    expect(r.issues.every((i) => i.layer === 'quality' && i.severity !== 'error')).toBe(true);
  });
});

describe('analyzeBundle — behaviour', () => {
  it('limits issues per code and records suppressed counts', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`c${i}.md`] = `---\ntype: T\n---\n\n[x](/missing-${i}.md)\n`;
    const r = await analyzeBundle(new MemorySource(files), { now: NOW, maxIssuesPerCode: 5 });
    expect(at(r.issues, 'Q_BROKEN_LINK')).toHaveLength(5);
    expect(r.validation.suppressed.Q_BROKEN_LINK).toBe(25);
  });

  it('never suppresses structural errors', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`c${i}.md`] = `no frontmatter ${i}`;
    const r = await analyzeBundle(new MemorySource(files), { now: NOW, maxIssuesPerCode: 2 });
    expect(r.validation.errors).toHaveLength(10);
  });

  it('reports unknown okf_version as info and still parses', async () => {
    const r = await analyzeBundle(
      new MemorySource({ 'index.md': '---\nokf_version: "9.1"\n---\n\n* [a](a.md) - A\n', 'a.md': '---\ntype: X\n---\n' }),
      { now: NOW },
    );
    expect(r.validation.valid).toBe(true);
    expect(at(r.issues, 'Q_UNKNOWN_OKF_VERSION')[0]?.severity).toBe('info');
    expect(r.validation.metadata.okfVersion).toBe('9.1');
  });

  it('detects case collisions', async () => {
    const r = await analyzeBundle(new MemorySource({ 'A.md': '---\ntype: X\n---\n', 'a.md': '---\ntype: X\n---\n' }), { now: NOW });
    expect(at(r.issues, 'Q_CASE_COLLISION')).toHaveLength(1);
  });

  it('is deterministic for a fixed clock', async () => {
    const a = await analyze('acme_retail');
    const b = await analyze('acme_retail');
    expect(JSON.stringify(a.validation)).toBe(JSON.stringify(b.validation));
  });
});

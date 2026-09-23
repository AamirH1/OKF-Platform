import { buildConcept } from './concept';
import { parseFrontmatter } from './frontmatter';
import { analyzeMarkdown } from './markdown';
import { conceptIdFromPath, isReservedName, looksLikePath, resolveLink } from './paths';
import {
  type BundleProfile,
  type FieldSchemaEntry,
  fieldSchemaFrom,
  profileBundle,
} from './profile';
import { parseIndexBody, parseLogBody } from './reserved';
import { type BundleSource, sha256Hex } from './source';
import {
  type BundleFileInfo,
  type Concept,
  type ConceptLink,
  type IndexFile,
  KNOWN_OKF_VERSIONS,
  type LogFile,
  OKF_SPEC_VERSION,
  type ValidationIssue,
  VALIDATOR_VERSION,
} from './types';

export interface AnalyzeOptions {
  /** Clock used for staleness (§5.5). */
  now?: Date;
  /** Markdown bodies larger than this are not parsed (frontmatter still is). */
  maxMarkdownBytes?: number;
  /** Cap on issues reported per code, to bound result size for huge bundles. */
  maxIssuesPerCode?: number;
  /** Cooperative cancellation/progress hook, called periodically. */
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

export interface BundleMetadata {
  okfVersion: string;
  declaredOkfVersion: string | null;
  conceptCount: number;
  types: string[];
  tags: string[];
  hasRootIndex: boolean;
  hasLog: boolean;
}

export interface ValidationResult {
  valid: boolean;
  specVersion: string;
  validatorVersion: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  infos: ValidationIssue[];
  counts: { errors: number; warnings: number; infos: number };
  /** Issues omitted by the per-code cap, keyed by code. */
  suppressed: Record<string, number>;
  metadata: BundleMetadata;
  schema: {
    fields: FieldSchemaEntry[];
    assetSchemas: { conceptId: string; format: string; columnCount: number }[];
  };
  statistics: Pick<BundleProfile, 'conceptCount' | 'totalBytes' | 'types' | 'trustTiers' | 'statuses' | 'staleCount' | 'links' | 'qualityScore'>;
}

export interface BundleAnalysis {
  files: BundleFileInfo[];
  ignoredFiles: string[];
  concepts: Concept[];
  indexes: IndexFile[];
  logs: LogFile[];
  issues: ValidationIssue[];
  validation: ValidationResult;
  profile: BundleProfile;
  fieldSchema: FieldSchemaEntry[];
}

export const DEFAULT_MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;

/**
 * Paths skipped as not part of the bundle tree: dot-files/dirs (`.git/`, `.DS_Store`) and
 * archive-tool artefacts (`__MACOSX/`). Platform decision, documented in okf-research.md.
 */
export function isIgnoredPath(p: string): boolean {
  return p.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX');
}

const isMarkdown = (p: string) => /\.md$/i.test(p);

class IssueCollector {
  readonly issues: ValidationIssue[] = [];
  readonly suppressed: Record<string, number> = {};
  private readonly perCode = new Map<string, number>();
  constructor(private readonly cap: number) {}

  add(issue: ValidationIssue): void {
    const n = (this.perCode.get(issue.code) ?? 0) + 1;
    this.perCode.set(issue.code, n);
    if (n > this.cap && issue.layer === 'quality') {
      this.suppressed[issue.code] = (this.suppressed[issue.code] ?? 0) + 1;
      return;
    }
    this.issues.push(issue);
  }

  structural(code: string, message: string, path: string, line?: number, field?: string): void {
    this.add({
      code,
      message,
      severity: 'error',
      layer: 'structural',
      location: line ? { path, line } : { path },
      ...(field ? { field } : {}),
    });
  }

  quality(code: string, severity: 'warning' | 'info', message: string, path: string, line?: number, field?: string): void {
    this.add({
      code,
      message,
      severity,
      layer: 'quality',
      location: line ? { path, line } : { path },
      ...(field ? { field } : {}),
    });
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function decode(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parse, validate and profile an OKF bundle. Pure with respect to the source:
 * reads files, never writes. Deterministic for a given `now`.
 */
export async function analyzeBundle(source: BundleSource, options: AnalyzeOptions = {}): Promise<BundleAnalysis> {
  const now = options.now ?? new Date();
  const maxMd = options.maxMarkdownBytes ?? DEFAULT_MAX_MARKDOWN_BYTES;
  const issues = new IssueCollector(options.maxIssuesPerCode ?? 500);

  const listed = await source.list();
  const ignoredFiles = listed.filter((f) => isIgnoredPath(f.path)).map((f) => f.path);
  const entries = listed.filter((f) => !isIgnoredPath(f.path));
  const existing = new Set(entries.map((f) => f.path));
  const directories = new Set<string>();
  for (const f of entries) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }

  const files: BundleFileInfo[] = [];
  const concepts: Concept[] = [];
  const indexes: IndexFile[] = [];
  const logs: LogFile[] = [];
  const rawLinks = new Map<string, { url: string; text: string | null; line: number | null }[]>();
  let declaredOkfVersion: string | null = null;
  let markdownBytes = 0;
  let totalBytes = 0;

  let done = 0;
  for (const entry of entries) {
    if (options.onProgress && done % 200 === 0) await options.onProgress(done, entries.length);
    done++;
    const bytes = await source.read(entry.path);
    const sha256 = sha256Hex(bytes);
    totalBytes += bytes.byteLength;
    const reserved = isReservedName(entry.path);
    const kind = !isMarkdown(entry.path) ? 'other' : reserved === 'index' ? 'index' : reserved === 'log' ? 'log' : 'concept';
    files.push({ path: entry.path, size: bytes.byteLength, sha256, kind });
    if (kind === 'other') continue;
    markdownBytes += bytes.byteLength;

    const text = decode(bytes);
    if (text === null) {
      issues.structural('OKF_NOT_UTF8', 'Markdown file is not valid UTF-8, so its frontmatter cannot be parsed.', entry.path);
      continue;
    }
    const fm = parseFrontmatter(text);

    if (kind === 'index') {
      const isRoot = entry.path === 'index.md';
      let body = text;
      let bodyLine = 1;
      if (fm.kind === 'unterminated' || fm.kind === 'invalid-yaml' || fm.kind === 'not-mapping') {
        issues.structural('OKF_INDEX_FRONTMATTER', 'index.md has a malformed frontmatter block (§8).', entry.path, fm.kind === 'invalid-yaml' ? fm.line : 1);
      } else if (fm.kind === 'ok') {
        body = fm.body;
        bodyLine = fm.bodyLine;
        const keys = Object.keys(fm.data);
        if (!isRoot && keys.length > 0) {
          issues.structural('OKF_INDEX_FRONTMATTER', 'index.md files contain no frontmatter, except `okf_version` in the bundle-root index.md (§8).', entry.path, 1);
        } else if (isRoot) {
          const extra = keys.filter((k) => k !== 'okf_version');
          if (extra.length > 0) {
            issues.structural('OKF_INDEX_FRONTMATTER', `The bundle-root index.md may only carry \`okf_version\` in frontmatter (§8); found: ${extra.join(', ')}.`, entry.path, fm.keyLines[extra[0]!] ?? 1, extra[0]);
          }
          if (fm.data.okf_version !== undefined && fm.data.okf_version !== null) {
            declaredOkfVersion = String(fm.data.okf_version);
          }
        }
      } else {
        body = fm.body;
      }
      const idxEntries = bytes.byteLength <= maxMd ? parseIndexBody(body, bodyLine - 1) : [];
      if (idxEntries.length === 0) {
        issues.quality('Q_INDEX_NO_ENTRIES', 'warning', 'index.md lists no `* [Title](url) - description` entries (§8).', entry.path);
      }
      const okfVersion = isRoot ? declaredOkfVersion : null;
      indexes.push({ path: entry.path, okfVersion, entries: idxEntries, sha256, bytes: bytes.byteLength });
      rawLinks.set(entry.path, idxEntries.map((e) => ({ url: e.href, text: e.title, line: e.line })));
      continue;
    }

    if (kind === 'log') {
      let body = text;
      let bodyLine = 1;
      if (fm.kind === 'unterminated' || fm.kind === 'invalid-yaml' || fm.kind === 'not-mapping') {
        issues.structural('OKF_LOG_FRONTMATTER', 'log.md has a malformed frontmatter block.', entry.path, fm.kind === 'invalid-yaml' ? fm.line : 1);
      } else {
        body = fm.body;
        if (fm.kind === 'ok') bodyLine = fm.bodyLine;
      }
      const log = parseLogBody(body, bodyLine - 1);
      for (const h of log.badHeadings) {
        issues.structural('OKF_LOG_DATE_HEADING', `log.md date headings MUST use ISO 8601 YYYY-MM-DD form (§9); got "${h.text}".`, entry.path, h.line);
      }
      for (let i = 1; i < log.groups.length; i++) {
        if (log.groups[i]!.date > log.groups[i - 1]!.date) {
          issues.quality('Q_LOG_ORDER', 'warning', 'log.md entries should be newest first (§9).', entry.path, log.groups[i]!.line);
          break;
        }
      }
      logs.push({ path: entry.path, groups: log.groups, sha256, bytes: bytes.byteLength });
      continue;
    }

    // Concept document — §11 rules 1 and 2.
    switch (fm.kind) {
      case 'absent':
        issues.structural('OKF_MISSING_FRONTMATTER', 'Concept document has no YAML frontmatter block; it must start with a `---` line (§4, §11).', entry.path, 1);
        continue;
      case 'unterminated':
        issues.structural('OKF_UNTERMINATED_FRONTMATTER', 'Frontmatter block is not closed by a `---` line.', entry.path, 1);
        continue;
      case 'invalid-yaml':
        issues.structural('OKF_INVALID_YAML', `Frontmatter is not parseable YAML: ${fm.message}`, entry.path, fm.line);
        continue;
      case 'not-mapping':
        issues.structural('OKF_FRONTMATTER_NOT_MAPPING', 'Frontmatter must be a YAML mapping of keys to values.', entry.path, fm.line);
        continue;
      case 'ok':
        break;
    }
    const t = fm.data.type;
    if (t === undefined || t === null || (typeof t === 'string' && t.trim() === '')) {
      issues.structural('OKF_MISSING_TYPE', 'Frontmatter must contain a non-empty `type` field (§4.1, §11).', entry.path, fm.keyLines.type ?? 1, 'type');
      continue;
    }
    const tooLarge = bytes.byteLength > maxMd;
    if (tooLarge) {
      issues.quality('Q_FILE_TOO_LARGE', 'warning', `Body larger than ${maxMd} bytes was not analysed for links or schema.`, entry.path);
    }
    const md = analyzeMarkdown(tooLarge ? '' : fm.body, fm.bodyLine - 1);
    const built = buildConcept({ path: entry.path, bytes: bytes.byteLength, sha256, frontmatter: fm, markdown: md, now });
    built.issues.forEach((i) => issues.add(i));
    concepts.push(built.concept);
    rawLinks.set(entry.path, md.links);
  }
  await options.onProgress?.(entries.length, entries.length);

  // Link resolution (§6). Broken links are tolerated: quality warnings only.
  const conceptIds = new Set(concepts.map((c) => c.id));
  const resolveInternal = (p: string, isDir: boolean): Pick<ConceptLink, 'kind' | 'targetPath' | 'targetConceptId' | 'broken'> => {
    const asDir = () => {
      if (directories.has(p) || p === '') {
        const idx = p ? `${p}/index.md` : 'index.md';
        return { kind: 'directory' as const, targetPath: existing.has(idx) ? idx : p, targetConceptId: null, broken: false };
      }
      return null;
    };
    if (isDir) return asDir() ?? { kind: 'directory', targetPath: p, targetConceptId: null, broken: true };
    const candidates = existing.has(p) ? [p] : !/\.[^/]+$/.test(p) && existing.has(`${p}.md`) ? [`${p}.md`] : [];
    const hit = candidates[0];
    if (hit) {
      const r = isReservedName(hit);
      if (isMarkdown(hit) && !r) {
        const id = conceptIdFromPath(hit);
        return { kind: 'concept', targetPath: hit, targetConceptId: conceptIds.has(id) ? id : null, broken: false };
      }
      return { kind: r ?? 'file', targetPath: hit, targetConceptId: null, broken: false };
    }
    return asDir() ?? { kind: isMarkdown(p) ? 'concept' : 'file', targetPath: p, targetConceptId: null, broken: true };
  };

  const toLink = (from: string, raw: { url: string; text: string | null; line: number | null }, via: string): ConceptLink | null => {
    const r = resolveLink(from, raw.url);
    const base = { via, raw: raw.url, line: raw.line, text: raw.text };
    if (r.kind === 'anchor') return null;
    if (r.kind === 'external') return { ...base, kind: 'external', targetPath: null, targetConceptId: null, broken: false };
    if (r.kind === 'escapes') {
      issues.quality('Q_LINK_ESCAPES_BUNDLE', 'warning', `Link "${raw.url}" points outside the bundle root.`, from, raw.line ?? undefined);
      return { ...base, kind: 'file', targetPath: null, targetConceptId: null, broken: true };
    }
    const res = resolveInternal(r.path, r.isDirectory);
    if (res.broken) {
      issues.quality('Q_BROKEN_LINK', 'warning', `Link target "${raw.url}" does not exist in the bundle (tolerated per §6.1; may be not-yet-written knowledge).`, from, raw.line ?? undefined);
    }
    return { ...base, ...res };
  };

  for (const c of concepts) {
    const links: ConceptLink[] = [];
    for (const raw of rawLinks.get(c.path) ?? []) {
      const l = toLink(c.path, raw, 'body');
      if (l) links.push(l);
    }
    // Path-valued frontmatter fields (§6.2). The samples write paths relative to the bundle
    // root without a leading slash, so fall back to root-relative resolution.
    const pathFields: { field: string; value: string | null }[] = [
      ...c.sources.map((s, i) => ({ field: `sources[${i}].resource`, value: s.resource })),
      { field: 'computation', value: c.computation?.computationPath ?? null },
      { field: 'executor.resource', value: c.computation?.executorResource ?? null },
      { field: 'attester.resource', value: c.computation?.attesterResource ?? null },
      { field: 'resource', value: c.resource && /\.md$/i.test(c.resource) ? c.resource : null },
    ];
    for (const { field, value } of pathFields) {
      if (!value || !looksLikePath(value)) continue;
      const rel = resolveLink(c.path, value);
      if (rel.kind !== 'internal') continue;
      let res = resolveInternal(rel.path, rel.isDirectory);
      if (res.broken && !value.startsWith('/') && !value.startsWith('.')) {
        const fromRoot = resolveLink('index.md', value);
        if (fromRoot.kind === 'internal') {
          const alt = resolveInternal(fromRoot.path, fromRoot.isDirectory);
          if (!alt.broken) res = alt;
        }
      }
      if (res.broken) {
        issues.quality('Q_UNRESOLVED_PATH_FIELD', 'info', `\`${field}\` "${value}" looks like a bundle path but no such file exists.`, c.path, undefined, field);
      }
      links.push({ via: field, raw: value, line: null, text: null, ...res });
    }
    c.links = links;
  }
  // Index entries are validated for broken targets too.
  for (const idx of indexes) {
    for (const raw of rawLinks.get(idx.path) ?? []) toLink(idx.path, raw, 'index');
  }

  // Bundle-level quality checks.
  if (concepts.length === 0) {
    issues.quality('Q_NO_CONCEPTS', 'warning', 'Bundle contains no concept documents.', '');
  }
  if (!indexes.some((i) => i.path === 'index.md')) {
    issues.quality('Q_NO_ROOT_INDEX', 'info', 'No bundle-root index.md; consumers may synthesize one (§8).', '');
  }
  if (declaredOkfVersion && !(KNOWN_OKF_VERSIONS as readonly string[]).includes(declaredOkfVersion)) {
    issues.quality('Q_UNKNOWN_OKF_VERSION', 'info', `Declared okf_version "${declaredOkfVersion}" is not one this validator knows; consumed best-effort (§12).`, 'index.md');
  }
  const lower = new Map<string, string>();
  for (const f of files) {
    const k = f.path.toLowerCase();
    const prev = lower.get(k);
    if (prev) issues.quality('Q_CASE_COLLISION', 'warning', `Paths "${prev}" and "${f.path}" differ only by case and collide on case-insensitive filesystems.`, f.path);
    else lower.set(k, f.path);
  }
  if (ignoredFiles.length > 0) {
    issues.quality('Q_IGNORED_FILES', 'info', `${ignoredFiles.length} hidden or archive-artefact file(s) (e.g. ${ignoredFiles[0]}) were ignored.`, '');
  }
  const listedInIndex = new Set<string>();
  for (const idx of indexes) {
    for (const raw of rawLinks.get(idx.path) ?? []) {
      const r = resolveLink(idx.path, raw.url);
      if (r.kind === 'internal') listedInIndex.add(conceptIdFromPath(r.path));
    }
  }
  const inbound = new Set<string>();
  for (const c of concepts) for (const l of c.links) if (l.targetConceptId && l.targetConceptId !== c.id) inbound.add(l.targetConceptId);
  for (const c of concepts) {
    if (!inbound.has(c.id) && !listedInIndex.has(c.id)) {
      issues.quality('Q_ORPHAN_CONCEPT', 'info', 'Concept is not linked from any other concept or index.md, so it is only discoverable by search.', c.path);
    }
  }

  const profile = profileBundle({
    concepts,
    indexFileCount: indexes.length,
    logFileCount: logs.length,
    otherFileCount: files.filter((f) => f.kind === 'other').length,
    ignoredFileCount: ignoredFiles.length,
    totalBytes,
    markdownBytes,
  });
  const fieldSchema = fieldSchemaFrom(profile.fields);
  const all = issues.issues;
  const errors = all.filter((i) => i.severity === 'error');
  const warnings = all.filter((i) => i.severity === 'warning');
  const infos = all.filter((i) => i.severity === 'info');
  const types = profile.types.map((t) => t.value);

  const validation: ValidationResult = {
    valid: errors.length === 0,
    specVersion: OKF_SPEC_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    errors,
    warnings,
    infos,
    counts: { errors: errors.length, warnings: warnings.length, infos: infos.length },
    suppressed: issues.suppressed,
    metadata: {
      okfVersion: declaredOkfVersion ?? OKF_SPEC_VERSION,
      declaredOkfVersion,
      conceptCount: concepts.length,
      types,
      tags: profile.tags.map((t) => t.value),
      hasRootIndex: indexes.some((i) => i.path === 'index.md'),
      hasLog: logs.length > 0,
    },
    schema: {
      fields: fieldSchema,
      assetSchemas: concepts
        .filter((c) => c.schema)
        .map((c) => ({ conceptId: c.id, format: c.schema!.format, columnCount: c.schema!.columns.length })),
    },
    statistics: {
      conceptCount: profile.conceptCount,
      totalBytes: profile.totalBytes,
      types: profile.types,
      trustTiers: profile.trustTiers,
      statuses: profile.statuses,
      staleCount: profile.staleCount,
      links: profile.links,
      qualityScore: profile.qualityScore,
    },
  };

  return { files, ignoredFiles, concepts, indexes, logs, issues: all, validation, profile, fieldSchema };
}

import type { FrontmatterResult } from './frontmatter';
import type { MarkdownAnalysis } from './markdown';
import { basename, conceptIdFromPath } from './paths';
import type {
  Actor,
  ComputationContract,
  ComputationParameter,
  Concept,
  JsonObject,
  JsonValue,
  LifecycleStatus,
  SourceEntry,
  TrustTier,
  ValidationIssue,
} from './types';

const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** OKF §5: every timestamp is ISO 8601 with an explicit UTC offset. */
export function isIsoWithOffset(value: string): boolean {
  return ISO_WITH_OFFSET.test(value) && !Number.isNaN(Date.parse(value));
}

const ACTOR_PATTERNS = [/^human:\S+$/, /^process:\S+$/, /^[^\s/:]+\/\S+$/, /^team:\S+$/];

/** §7 actor convention; `team:` is accepted because Google's samples use it for source authors. */
export function isConventionalActor(value: string): boolean {
  return ACTOR_PATTERNS.some((re) => re.test(value));
}

/** §5.2: a bare `{ by, at }` mapping MUST be treated as a one-element list. */
export function normalizeVerified(value: JsonValue | undefined): JsonValue[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/** §5.3 trust tiers. */
export function trustTier(verified: Actor[]): TrustTier {
  if (verified.length === 0) return 'unverified';
  return verified.some((v) => v.by.startsWith('human:')) ? 'human-reviewed' : 'machine-confirmed';
}

/**
 * §5.5: stale when now >= stale_after. Values without a time and explicit offset are
 * ignored (a date-only value names a different instant in every timezone), matching
 * Google's reference implementation.
 */
export function isStale(staleAfter: string | null, now: Date): boolean {
  if (!staleAfter || !isIsoWithOffset(staleAfter)) return false;
  return now.getTime() >= Date.parse(staleAfter);
}

/** Derive a display title from a filename when `title` is absent (§4.1 MAY). */
export function titleFromPath(p: string): string {
  const stem = basename(p).replace(/\.md$/i, '');
  const words = stem.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : stem;
}

const str = (v: JsonValue | undefined): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;
const isObj = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ConceptInput {
  path: string;
  bytes: number;
  sha256: string;
  frontmatter: Extract<FrontmatterResult, { kind: 'ok' }>;
  markdown: MarkdownAnalysis;
  now: Date;
}

/** Build a normalized concept and its quality issues. Caller has already checked `type`. */
export function buildConcept(input: ConceptInput): { concept: Concept; issues: ValidationIssue[] } {
  const { path, frontmatter: fm, markdown: md, now } = input;
  const data = fm.data;
  const issues: ValidationIssue[] = [];
  const q = (
    code: string,
    severity: 'warning' | 'info',
    message: string,
    field?: string,
    line?: number,
  ): void => {
    const topKey = field?.split(/[.[]/)[0];
    const l = line ?? (topKey ? fm.keyLines[topKey] : undefined);
    issues.push({
      code,
      severity,
      layer: 'quality',
      message,
      location: l ? { path, line: l } : { path },
      ...(field ? { field } : {}),
    });
  };
  const checkTimestamp = (value: JsonValue | undefined, field: string): string | null => {
    if (value === undefined || value === null) return null;
    const s = typeof value === 'string' ? value : String(value);
    if (!isIsoWithOffset(s)) {
      q('Q_TIMESTAMP_FORMAT', 'warning', `\`${field}\` should be an ISO 8601 datetime with an explicit UTC offset (e.g. 2026-06-30T14:00:00Z), got "${s}".`, field);
    }
    return s;
  };
  const checkActor = (value: string, field: string): void => {
    if (!isConventionalActor(value)) {
      q('Q_ACTOR_FORMAT', 'info', `\`${field}\` "${value}" does not follow the actor convention (<producer>/<version>, human:<id>, process:<id>).`, field);
    }
  };

  // type — presence is structural (checked by caller); a non-string value is tolerated.
  const rawType = data.type;
  const type = typeof rawType === 'string' ? rawType.trim() : String(rawType);
  if (typeof rawType !== 'string') {
    q('Q_TYPE_NOT_STRING', 'warning', '`type` should be a short string.', 'type');
  }

  // title / description / resource / tags (§4.1 recommended)
  const title = str(data.title);
  if (!title) q('Q_MISSING_TITLE', 'info', 'No `title`; a title is derived from the filename.', 'title', 1);
  const description = str(data.description);
  if (!description) q('Q_MISSING_DESCRIPTION', 'warning', 'No `description`; it is used by index files, search snippets and previews.', 'description', 1);
  if (data.resource !== undefined && typeof data.resource !== 'string') {
    q('Q_RESOURCE_NOT_STRING', 'warning', '`resource` should be a URI string.', 'resource');
  }
  const tags: string[] = [];
  if (data.tags !== undefined && data.tags !== null) {
    if (!Array.isArray(data.tags)) {
      q('Q_TAGS_NOT_LIST', 'warning', '`tags` should be a YAML list of strings.', 'tags');
      if (typeof data.tags === 'string') tags.push(data.tags);
    } else {
      data.tags.forEach((t, i) => {
        if (typeof t === 'string' || typeof t === 'number') tags.push(String(t));
        else q('Q_TAG_NOT_STRING', 'warning', `\`tags[${i}]\` should be a string.`, `tags[${i}]`);
      });
    }
  }

  // lifecycle (§5.4, §5.5)
  let status: LifecycleStatus = 'stable';
  if (data.status !== undefined && data.status !== null) {
    if (data.status === 'draft' || data.status === 'stable' || data.status === 'deprecated') {
      status = data.status;
    } else {
      q('Q_INVALID_STATUS', 'warning', `\`status\` must be one of draft, stable, deprecated; got "${String(data.status)}". Treated as stable.`, 'status');
    }
  }
  let staleAfter: string | null = null;
  if (data.stale_after !== undefined && data.stale_after !== null) {
    staleAfter = String(data.stale_after);
    if (!isIsoWithOffset(staleAfter)) {
      q('Q_STALE_AFTER_IGNORED', 'warning', '`stale_after` is not an ISO 8601 datetime with an explicit offset, so staleness cannot be determined and it is ignored.', 'stale_after');
    }
  }
  const stale = isStale(staleAfter, now);
  if (stale) q('Q_STALE', 'warning', `Concept is stale: \`stale_after\` (${staleAfter}) has passed.`, 'stale_after');

  // trust (§5.2)
  let generated: Actor | null = null;
  if (data.generated !== undefined && data.generated !== null) {
    if (!isObj(data.generated)) {
      q('Q_GENERATED_MALFORMED', 'warning', '`generated` should be a mapping `{ by, at }`.', 'generated');
    } else {
      const by = str(data.generated.by);
      if (!by) q('Q_GENERATED_MISSING_BY', 'warning', '`generated.by` is required within `generated`.', 'generated.by');
      else checkActor(by, 'generated.by');
      const at = checkTimestamp(data.generated.at, 'generated.at');
      generated = { by: by ?? '', at };
    }
  }
  let lastChangedAt = generated?.at ?? null;
  if (!generated && data.timestamp !== undefined) {
    lastChangedAt = checkTimestamp(data.timestamp, 'timestamp');
    q('Q_LEGACY_TIMESTAMP', 'info', 'Uses v0.1 `timestamp`; v0.2 supersedes it with `generated: { by, at }`.', 'timestamp');
  }

  const verified: Actor[] = [];
  normalizeVerified(data.verified).forEach((v, i) => {
    const field = Array.isArray(data.verified) ? `verified[${i}]` : 'verified';
    if (!isObj(v) || !str(v.by)) {
      q('Q_VERIFIED_MALFORMED', 'warning', `\`${field}\` should be a mapping with a \`by\` actor and an \`at\` datetime.`, field);
      return;
    }
    const by = str(v.by)!;
    checkActor(by, `${field}.by`);
    verified.push({ by, at: checkTimestamp(v.at, `${field}.at`) });
  });

  // provenance (§5.1)
  const sources: SourceEntry[] = [];
  if (data.sources !== undefined && data.sources !== null) {
    if (!Array.isArray(data.sources)) {
      q('Q_SOURCES_NOT_LIST', 'warning', '`sources` should be a list of entries.', 'sources');
    } else {
      const seen = new Set<string>();
      data.sources.forEach((s, i) => {
        const field = `sources[${i}]`;
        if (!isObj(s)) {
          q('Q_SOURCE_MALFORMED', 'warning', `\`${field}\` should be a mapping.`, field);
          return;
        }
        const resource = s.resource === undefined || s.resource === null ? null : String(s.resource);
        if (!resource) q('Q_SOURCE_MISSING_RESOURCE', 'warning', `\`${field}.resource\` is required within a sources entry.`, `${field}.resource`);
        const id = s.id === undefined || s.id === null ? null : String(s.id);
        if (id) {
          if (seen.has(id)) q('Q_SOURCE_DUPLICATE_ID', 'warning', `Duplicate sources id "${id}"; footnote attribution becomes ambiguous.`, `${field}.id`);
          seen.add(id);
        }
        const author = str(s.author);
        if (author) checkActor(author, `${field}.author`);
        let usageCount: number | null = null;
        if (s.usage_count !== undefined && s.usage_count !== null) {
          if (typeof s.usage_count === 'number' && Number.isInteger(s.usage_count) && s.usage_count >= 0) usageCount = s.usage_count;
          else q('Q_USAGE_COUNT_INVALID', 'warning', `\`${field}.usage_count\` should be a non-negative integer.`, `${field}.usage_count`);
        }
        sources.push({
          id,
          resource,
          title: str(s.title),
          author,
          usageCount,
          lastModified: checkTimestamp(s.last_modified, `${field}.last_modified`),
        });
      });
    }
  }
  if (isObj(data.usage_window)) {
    checkTimestamp(data.usage_window.from, 'usage_window.from');
    checkTimestamp(data.usage_window.to, 'usage_window.to');
  }
  const sourceIds = new Set(sources.map((s) => s.id).filter((x): x is string => !!x));
  if (sourceIds.size > 0) {
    for (const label of md.footnoteLabels) {
      if (!sourceIds.has(label)) {
        q('Q_FOOTNOTE_UNKNOWN_SOURCE', 'info', `Footnote [^${label}] does not match any \`sources[].id\`, so the claim cannot be attributed.`);
      }
    }
  }
  if (md.hasCitationsHeading) {
    q('Q_LEGACY_CITATIONS', 'info', 'Uses a v0.1 `# Citations` body list; v0.2 supersedes it with `sources` frontmatter.');
  }

  // Attested Computation (§10)
  let computation: ComputationContract | null = null;
  if (type === 'Attested Computation') {
    const runtime = str(data.runtime);
    if (!runtime) q('Q_COMPUTATION_MISSING_RUNTIME', 'warning', '`runtime` is REQUIRED for an Attested Computation (§10.2).', 'runtime', 1);
    const parameters: ComputationParameter[] = [];
    if (data.parameters !== undefined && data.parameters !== null) {
      if (!Array.isArray(data.parameters)) {
        q('Q_COMPUTATION_PARAMETERS_MALFORMED', 'warning', '`parameters` should be a list of `{ name, type, required }`.', 'parameters');
      } else {
        data.parameters.forEach((p, i) => {
          if (!isObj(p) || !str(p.name)) {
            q('Q_COMPUTATION_PARAMETERS_MALFORMED', 'warning', `\`parameters[${i}]\` should be a mapping with a \`name\`.`, `parameters[${i}]`);
            return;
          }
          parameters.push({ name: str(p.name)!, type: str(p.type), required: p.required === true });
        });
      }
    }
    const executor = isObj(data.executor) ? data.executor : null;
    const attester = isObj(data.attester) ? data.attester : null;
    const computationPath = str(data.computation);
    if (!computationPath && !md.computationCode) {
      q('Q_COMPUTATION_MISSING', 'warning', 'No `computation` path and no code block under a `# Computation` heading (§10.3).', undefined, 1);
    }
    computation = {
      runtime,
      parameters,
      computationPath,
      executorResource: executor ? str(executor.resource) : null,
      receipt: executor && Array.isArray(executor.receipt) ? executor.receipt.map(String) : [],
      attesterResource: attester ? str(attester.resource) : null,
      inlineCode: md.computationCode?.code ?? null,
      inlineLanguage: md.computationCode?.lang ?? null,
    };
  }

  if (md.schemaUnparseable) {
    q('Q_SCHEMA_UNPARSEABLE', 'info', 'A `Schema` heading exists but no table or `name`: TYPE list could be parsed from it.');
  }
  if (md.wordCount === 0) q('Q_EMPTY_BODY', 'info', 'Concept has no body content.');
  for (const w of fm.warnings) q('Q_YAML_WARNING', 'warning', `YAML: ${w.message}`, undefined, w.line);

  const concept: Concept = {
    id: conceptIdFromPath(path),
    path,
    type,
    title: title ?? titleFromPath(path),
    titleDerived: !title,
    description,
    resource: typeof data.resource === 'string' ? data.resource : null,
    tags,
    status,
    staleAfter,
    isStale: stale,
    generated,
    lastChangedAt,
    verified,
    trustTier: trustTier(verified),
    sources,
    computation,
    frontmatter: data,
    headings: md.headings,
    links: [],
    footnoteLabels: md.footnoteLabels,
    schema: md.schema,
    wordCount: md.wordCount,
    bytes: input.bytes,
    sha256: input.sha256,
    excerpt: md.excerpt,
    body: fm.body,
  };
  return { concept, issues };
}

/** Latest OKF specification version this engine implements. */
export const OKF_SPEC_VERSION = '0.2';
/** Versions whose semantics this engine understands (v0.1 via the §13 fallbacks). */
export const KNOWN_OKF_VERSIONS = ['0.1', '0.2'] as const;
/** Version of this validator's rule set; bump when rules change. */
export const VALIDATOR_VERSION = '1.0.0';

export type Severity = 'error' | 'warning' | 'info';

/**
 * `structural` = OKF v0.2 §11 conformance (only these make a bundle invalid).
 * `quality` = platform heuristics; never affect validity (ADR-0003).
 */
export type IssueLayer = 'structural' | 'quality';

export interface IssueLocation {
  /** Bundle-relative POSIX path of the file, or '' for bundle-level issues. */
  path: string;
  line?: number;
  column?: number;
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: Severity;
  layer: IssueLayer;
  location: IssueLocation;
  /** Frontmatter field path such as `sources[1].resource`, when applicable. */
  field?: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';
export type LifecycleStatus = 'draft' | 'stable' | 'deprecated';

export interface Actor {
  by: string;
  at: string | null;
}

export interface SourceEntry {
  id: string | null;
  resource: string | null;
  title: string | null;
  author: string | null;
  usageCount: number | null;
  lastModified: string | null;
}

export type LinkKind = 'concept' | 'index' | 'log' | 'file' | 'directory' | 'external' | 'anchor';

export interface ConceptLink {
  /** Where the link was found: `body`, or a frontmatter field path such as `sources[0].resource`. */
  via: string;
  raw: string;
  kind: LinkKind;
  /** Bundle-relative target path (no leading slash) for internal links; null for external/anchor. */
  targetPath: string | null;
  /** Concept ID when the target is an existing concept. */
  targetConceptId: string | null;
  broken: boolean;
  line: number | null;
  text: string | null;
}

export type SchemaFormat = 'table' | 'list';

export interface AssetSchemaColumn {
  ordinal: number;
  name: string;
  dataType: string | null;
  mode: string | null;
  description: string | null;
}

export interface AssetSchema {
  format: SchemaFormat;
  headingLine: number;
  columns: AssetSchemaColumn[];
}

export interface ComputationParameter {
  name: string;
  type: string | null;
  required: boolean;
}

export interface ComputationContract {
  runtime: string | null;
  parameters: ComputationParameter[];
  computationPath: string | null;
  executorResource: string | null;
  receipt: string[];
  attesterResource: string | null;
  /** Inline code from the `# Computation` fence, when present. */
  inlineCode: string | null;
  inlineLanguage: string | null;
}

export interface Heading {
  depth: number;
  text: string;
  line: number;
}

export interface Concept {
  /** Concept ID (§2): path without `.md`. */
  id: string;
  path: string;
  type: string;
  title: string;
  titleDerived: boolean;
  description: string | null;
  resource: string | null;
  tags: string[];
  status: LifecycleStatus;
  staleAfter: string | null;
  isStale: boolean;
  generated: Actor | null;
  /** `generated.at`, or legacy v0.1 `timestamp` when `generated` is absent. */
  lastChangedAt: string | null;
  verified: Actor[];
  trustTier: TrustTier;
  sources: SourceEntry[];
  computation: ComputationContract | null;
  /** Complete frontmatter, JSON-safe, key order preserved. */
  frontmatter: JsonObject;
  headings: Heading[];
  links: ConceptLink[];
  footnoteLabels: string[];
  schema: AssetSchema | null;
  wordCount: number;
  bytes: number;
  sha256: string;
  /** Plain-text body excerpt for search indexing. */
  excerpt: string;
  body: string;
}

export interface IndexEntry {
  title: string;
  href: string;
  description: string | null;
  section: string | null;
  line: number;
}

export interface IndexFile {
  path: string;
  okfVersion: string | null;
  entries: IndexEntry[];
  sha256: string;
  bytes: number;
}

export interface LogEntryGroup {
  date: string;
  line: number;
  entries: string[];
}

export interface LogFile {
  path: string;
  groups: LogEntryGroup[];
  sha256: string;
  bytes: number;
}

export type BundleFileKind = 'concept' | 'index' | 'log' | 'other';

export interface BundleFileInfo {
  path: string;
  size: number;
  sha256: string;
  kind: BundleFileKind;
}

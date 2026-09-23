import type { Code, List, Root, RootContent, Table } from 'mdast';
import { toString } from 'mdast-util-to-string';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import type { AssetSchema, AssetSchemaColumn, Heading } from './types';

export interface RawLink {
  url: string;
  text: string | null;
  line: number | null;
}

export interface MarkdownAnalysis {
  headings: Heading[];
  links: RawLink[];
  footnoteLabels: string[];
  schema: AssetSchema | null;
  /** True when a `Schema` heading exists but no table/list could be parsed from it. */
  schemaUnparseable: boolean;
  computationCode: { code: string; lang: string | null; line: number } | null;
  hasComputationHeading: boolean;
  hasCitationsHeading: boolean;
  wordCount: number;
  excerpt: string;
}

const processor = unified().use(remarkParse).use(remarkGfm);

export const EXCERPT_CHARS = 4000;

export function parseMarkdown(markdown: string): Root {
  return processor.parse(markdown);
}

/**
 * Analyse a concept body. `lineOffset` converts body-relative lines to file lines.
 */
export function analyzeMarkdown(body: string, lineOffset = 0): MarkdownAnalysis {
  const tree = parseMarkdown(body);
  const line = (n: { position?: { start: { line: number } } }): number | null =>
    n.position ? n.position.start.line + lineOffset : null;

  const headings: Heading[] = [];
  const links: RawLink[] = [];
  const footnotes = new Set<string>();

  visit(tree, (node) => {
    switch (node.type) {
      case 'heading':
        headings.push({ depth: node.depth, text: toString(node).trim(), line: line(node) ?? 0 });
        break;
      case 'link':
        links.push({ url: node.url, text: toString(node) || null, line: line(node) });
        break;
      case 'definition':
        links.push({ url: node.url, text: node.label ?? null, line: line(node) });
        break;
      case 'footnoteReference':
        footnotes.add(node.label ?? node.identifier);
        break;
      default:
        break;
    }
  });

  const schemaSection = findSection(tree, /^schema$/i);
  let schema: AssetSchema | null = null;
  let schemaUnparseable = false;
  if (schemaSection) {
    schema = extractSchema(schemaSection.nodes, schemaSection.headingLine + lineOffset);
    schemaUnparseable = schema === null;
  }

  const computationSection = findSection(tree, /^computation$/i);
  let computationCode: MarkdownAnalysis['computationCode'] = null;
  if (computationSection) {
    const code = computationSection.nodes.find((n): n is Code => n.type === 'code');
    if (code) computationCode = { code: code.value, lang: code.lang ?? null, line: line(code) ?? 0 };
  }

  const plain = tree.children
    .map((n) => toString(n))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    headings,
    links,
    footnoteLabels: [...footnotes],
    schema,
    schemaUnparseable,
    computationCode,
    hasComputationHeading: computationSection !== null,
    hasCitationsHeading: headings.some((h) => /^citations$/i.test(h.text)),
    wordCount: plain ? plain.split(' ').length : 0,
    excerpt: plain.slice(0, EXCERPT_CHARS),
  };
}

interface Section {
  headingLine: number;
  nodes: RootContent[];
}

/** Top-level nodes between a matching heading and the next heading of the same or higher level. */
function findSection(tree: Root, title: RegExp): Section | null {
  const children = tree.children;
  for (let i = 0; i < children.length; i++) {
    const node = children[i]!;
    if (node.type !== 'heading' || !title.test(toString(node).trim())) continue;
    const nodes: RootContent[] = [];
    for (let j = i + 1; j < children.length; j++) {
      const next = children[j]!;
      if (next.type === 'heading' && next.depth <= node.depth) break;
      nodes.push(next);
    }
    return { headingLine: node.position?.start.line ?? 0, nodes };
  }
  return null;
}

const NAME_HEADERS = /^(column|column name|field|field name|name|attribute|property)$/i;
const TYPE_HEADERS = /^(type|data type|datatype|field type|column type)$/i;
const MODE_HEADERS = /^(mode|nullable|nullability)$/i;
const DESC_HEADERS = /^(description|desc|notes?|comment|meaning)$/i;

/**
 * Parse the first table or list in a `# Schema` section (OKF §4.2 conventional heading).
 * The spec does not fix the format; Google's samples use both a
 * `Column | Type | Description` table and `` - `name`: TYPE, description `` lists.
 */
export function extractSchema(nodes: RootContent[], headingLine: number): AssetSchema | null {
  for (const node of nodes) {
    if (node.type === 'table') {
      const columns = schemaFromTable(node);
      if (columns.length > 0) return { format: 'table', headingLine, columns };
    }
    if (node.type === 'list') {
      const columns = schemaFromList(node);
      if (columns.length > 0) return { format: 'list', headingLine, columns };
    }
  }
  return null;
}

function schemaFromTable(table: Table): AssetSchemaColumn[] {
  const [header, ...rows] = table.children;
  if (!header) return [];
  const heads = header.children.map((c) => toString(c).trim());
  const find = (re: RegExp) => heads.findIndex((h) => re.test(h));
  let nameIdx = find(NAME_HEADERS);
  if (nameIdx === -1) nameIdx = 0;
  const typeIdx = find(TYPE_HEADERS);
  const modeIdx = find(MODE_HEADERS);
  const descIdx = find(DESC_HEADERS);
  const cell = (row: (typeof rows)[number], idx: number): string | null => {
    if (idx < 0) return null;
    const c = row.children[idx];
    const v = c ? toString(c).trim() : '';
    return v === '' ? null : v;
  };
  const out: AssetSchemaColumn[] = [];
  for (const row of rows) {
    const name = cell(row, nameIdx);
    if (!name) continue;
    out.push({
      ordinal: out.length + 1,
      name,
      dataType: cell(row, typeIdx),
      mode: cell(row, modeIdx),
      description: cell(row, descIdx),
    });
  }
  return out;
}

const LOWER_TYPES = new Set([
  'string', 'str', 'text', 'varchar', 'char', 'int', 'integer', 'int64', 'bigint', 'smallint',
  'float', 'float64', 'double', 'real', 'numeric', 'decimal', 'number', 'bool', 'boolean',
  'date', 'datetime', 'time', 'timestamp', 'timestamptz', 'json', 'jsonb', 'bytes', 'binary',
  'array', 'struct', 'record', 'map', 'uuid', 'geography', 'interval', 'object',
]);

function schemaFromList(list: List): AssetSchemaColumn[] {
  const out: AssetSchemaColumn[] = [];
  for (const item of list.children) {
    const para = item.children[0];
    if (!para || para.type !== 'paragraph') continue;
    const first = para.children[0];
    if (!first || first.type !== 'inlineCode') continue;
    const name = first.value.trim();
    if (!name) continue;
    const rest = para.children
      .slice(1)
      .map((c) => toString(c))
      .join('')
      .replace(/^\s*[:\-–—]\s*/, '')
      .trim();
    const { dataType, remainder } = splitLeadingType(rest);
    out.push({
      ordinal: out.length + 1,
      name,
      dataType,
      mode: null,
      description: remainder || null,
    });
  }
  return out;
}

/** Parse a leading type token like `INTEGER`, `(STRING)`, `NUMERIC(18,4)`, `ARRAY<STRUCT<a INT64>>`. */
export function splitLeadingType(text: string): { dataType: string | null; remainder: string } {
  let s = text.trim();
  const paren = s.startsWith('(');
  if (paren) s = s.slice(1);
  const m = /^[A-Za-z][A-Za-z0-9_]*/.exec(s);
  if (!m) return { dataType: null, remainder: text.trim() };
  let i = m[0].length;
  const opener = s[i];
  if (opener === '<' || opener === '(') {
    const close = opener === '<' ? '>' : ')';
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === opener) depth++;
      else if (s[i] === close && --depth === 0) {
        i++;
        break;
      }
    }
    if (depth !== 0) return { dataType: null, remainder: text.trim() };
  }
  const token = s.slice(0, i);
  const base = m[0];
  const looksLikeType = base === base.toUpperCase() || LOWER_TYPES.has(base.toLowerCase());
  if (!looksLikeType) return { dataType: null, remainder: text.trim() };
  let rest = s.slice(i);
  if (paren) {
    if (!rest.startsWith(')')) return { dataType: null, remainder: text.trim() };
    rest = rest.slice(1);
  }
  // A type must be followed by a separator or end of text, otherwise it is prose.
  if (rest !== '' && !/^\s*[,:\-–—;]/.test(rest) && !/^\s+$/.test(rest)) {
    return { dataType: null, remainder: text.trim() };
  }
  return { dataType: token, remainder: rest.replace(/^\s*[,:\-–—;]\s*/, '').trim() };
}

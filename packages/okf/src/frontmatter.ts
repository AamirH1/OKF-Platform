import { isMap, isScalar, LineCounter, parseDocument } from 'yaml';
import type { JsonObject, JsonValue } from './types';

export type FrontmatterResult =
  | {
      kind: 'ok';
      data: JsonObject;
      /** 1-based line of each top-level key within the whole file. */
      keyLines: Record<string, number>;
      body: string;
      /** 1-based line where the body starts. */
      bodyLine: number;
      warnings: { message: string; line: number }[];
    }
  | { kind: 'absent'; body: string }
  | { kind: 'unterminated' }
  | { kind: 'invalid-yaml'; message: string; line: number; column: number }
  | { kind: 'not-mapping'; line: number };

const DELIM = '---';
/** Billion-laughs guard: max alias expansions when materializing YAML. */
const MAX_ALIAS_COUNT = 100;
/** Frontmatter larger than this is refused (it is meant to be a small metadata block). */
export const MAX_FRONTMATTER_BYTES = 256 * 1024;

/**
 * Split a document into YAML frontmatter and markdown body (OKF §4) and parse the YAML.
 *
 * Uses the YAML 1.2 core schema, so ISO timestamps stay strings exactly as written —
 * the same behavior as Google's reference parser, which strips PyYAML's timestamp
 * resolver to keep round-trips byte-identical.
 */
export function parseFrontmatter(text: string): FrontmatterResult {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = src.split(/\r?\n/);
  if (lines.length === 0 || lines[0]?.trimEnd() !== DELIM) {
    return { kind: 'absent', body: src };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === DELIM) {
      end = i;
      break;
    }
  }
  if (end === -1) return { kind: 'unterminated' };

  const yamlText = lines.slice(1, end).join('\n');
  if (Buffer.byteLength(yamlText) > MAX_FRONTMATTER_BYTES) {
    return {
      kind: 'invalid-yaml',
      message: `Frontmatter exceeds ${MAX_FRONTMATTER_BYTES} bytes`,
      line: 2,
      column: 1,
    };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(yamlText, {
    version: '1.2',
    schema: 'core',
    // The reference parser (PyYAML) accepts duplicate keys (last wins); so do we.
    uniqueKeys: false,
    prettyErrors: true,
    lineCounter,
  });

  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    const pos = err.linePos?.[0];
    return {
      kind: 'invalid-yaml',
      message: err.message.split('\n')[0] ?? 'Invalid YAML',
      line: (pos?.line ?? 1) + 1,
      column: pos?.col ?? 1,
    };
  }

  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (e) {
    return {
      kind: 'invalid-yaml',
      message: e instanceof Error ? e.message : 'Invalid YAML',
      line: 2,
      column: 1,
    };
  }

  // An empty block (`---\n---`) is a parseable mapping with no keys.
  if (value === null || value === undefined) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'not-mapping', line: 2 };

  const keyLines: Record<string, number> = {};
  if (isMap(doc.contents)) {
    for (const item of doc.contents.items) {
      if (isScalar(item.key) && item.key.range) {
        keyLines[String(item.key.value)] = lineCounter.linePos(item.key.range[0]).line + 1;
      }
    }
  }

  const warnings = doc.warnings.map((w) => ({
    message: w.message.split('\n')[0] ?? w.message,
    line: (w.linePos?.[0]?.line ?? 1) + 1,
  }));

  const bodyLines = lines.slice(end + 1);
  // Conventionally one blank line separates frontmatter from body.
  let bodyLine = end + 2;
  if (bodyLines[0] !== undefined && bodyLines[0].trim() === '') {
    bodyLines.shift();
    bodyLine += 1;
  }

  return {
    kind: 'ok',
    data: toJsonSafe(value) as JsonObject,
    keyLines,
    body: bodyLines.join('\n'),
    bodyLine,
    warnings,
  };
}

/** Convert YAML-produced JS values into JSON-serializable values (for JSONB/parquet storage). */
export function toJsonSafe(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Set) return [...value].map(toJsonSafe);
  if (value instanceof Map) {
    const out: JsonObject = {};
    for (const [k, v] of value) out[String(k)] = toJsonSafe(v);
    return out;
  }
  if (typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return String(value);
}

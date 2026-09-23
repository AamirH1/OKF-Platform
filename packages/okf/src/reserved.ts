import type { Link, List, Paragraph } from 'mdast';
import { toString } from 'mdast-util-to-string';
import { parseMarkdown } from './markdown';
import type { IndexEntry, LogEntryGroup } from './types';

/** Parse index.md bullets `* [Title](url) - description` grouped by heading (OKF §8). */
export function parseIndexBody(body: string, lineOffset: number): IndexEntry[] {
  const tree = parseMarkdown(body);
  const entries: IndexEntry[] = [];
  let section: string | null = null;
  const visitList = (list: List): void => {
    for (const item of list.children) {
      const para = item.children.find((c): c is Paragraph => c.type === 'paragraph');
      if (!para) continue;
      const linkIdx = para.children.findIndex((c) => c.type === 'link');
      if (linkIdx === -1) continue;
      const link = para.children[linkIdx] as Link;
      const rest = para.children
        .slice(linkIdx + 1)
        .map((c) => toString(c))
        .join('')
        .replace(/^\s*[-–—:]\s*/, '')
        .trim();
      entries.push({
        title: toString(link).trim(),
        href: link.url,
        description: rest || null,
        section,
        line: (link.position?.start.line ?? 0) + lineOffset,
      });
      for (const child of item.children) if (child.type === 'list') visitList(child);
    }
  };
  for (const node of tree.children) {
    if (node.type === 'heading') section = toString(node).trim();
    else if (node.type === 'list') visitList(node);
  }
  return entries;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoCalendarDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export interface LogParse {
  groups: LogEntryGroup[];
  /** `##` headings that are not ISO `YYYY-MM-DD` dates (OKF §9 MUST). */
  badHeadings: { text: string; line: number }[];
}

/** Parse log.md: date-grouped entries under `##` headings, newest first (OKF §9). */
export function parseLogBody(body: string, lineOffset: number): LogParse {
  const tree = parseMarkdown(body);
  const groups: LogEntryGroup[] = [];
  const badHeadings: LogParse['badHeadings'] = [];
  let current: LogEntryGroup | null = null;
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 2) {
      const text = toString(node).trim();
      const line = (node.position?.start.line ?? 0) + lineOffset;
      if (isIsoCalendarDate(text)) {
        current = { date: text, line, entries: [] };
        groups.push(current);
      } else {
        badHeadings.push({ text, line });
        current = null;
      }
    } else if (node.type === 'list' && current) {
      for (const item of node.children) current.entries.push(toString(item).trim());
    }
  }
  return { groups, badHeadings };
}

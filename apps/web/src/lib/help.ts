/**
 * All plain-language explanations shown in the UI live here, so the Home page,
 * the per-tab tips and the glossary hover-cards always say the same thing.
 * Write for someone who has never heard of OKF: short sentences, no jargon.
 */

export const GLOSSARY = {
  okf: {
    term: 'OKF (Open Knowledge Format)',
    text: 'An open, simple way to write down knowledge about data — what a table means, how a number is calculated, who checked it — as a folder of Markdown text files.',
  },
  bundle: {
    term: 'Bundle',
    text: 'The folder of OKF files you upload, usually as a .zip or .tar.gz. One bundle = one version of a dataset.',
  },
  dataset: {
    term: 'Dataset',
    text: 'A named home for a bundle on this platform. It keeps every version you upload, plus who can see it.',
  },
  concept: {
    term: 'Concept',
    text: 'One Markdown file in the bundle describing one thing — a table, a metric, a policy, a how-to guide. Think of it as one row in the dataset.',
  },
  version: {
    term: 'Version',
    text: 'A frozen snapshot created by each upload (v1, v2, …). Versions never change after processing, so you can always compare or roll back.',
  },
  conformant: {
    term: 'Conformant',
    text: 'The bundle follows the OKF rules: every concept file has a small header with at least a “type”. Only conformant versions can be published.',
  },
  quality: {
    term: 'Quality checks',
    text: 'Helpful suggestions (missing descriptions, broken links, out-of-date content). They never block publishing.',
  },
  trust: {
    term: 'Trust tier',
    text: 'How much a concept has been checked: unverified, confirmed by a machine, or reviewed by a person.',
  },
  stale: {
    term: 'Stale',
    text: 'The author set an expiry date for a concept and that date has passed, so it may be out of date.',
  },
  published: {
    term: 'Published',
    text: 'The version you officially share. Viewers outside your team only ever see the published version, never drafts.',
  },
  schema: {
    term: 'Schema',
    text: 'The list of columns (names and types) a concept documents for a table. Taken from the “# Schema” section of the file.',
  },
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;

export const STEPS = [
  {
    title: 'Upload your bundle',
    text: 'Drag a .zip or .tar.gz of your OKF folder onto the page. It goes straight to secure storage — large files are split into parts so a bad connection can resume.',
  },
  {
    title: 'We check it automatically',
    text: 'In the background we scan for malware, safely unpack it, and check it follows the OKF rules. You can watch the progress bar.',
  },
  {
    title: 'Explore what’s inside',
    text: 'See every concept, the columns tables document, links between concepts as a graph, and simple statistics. Search across everything, or ask questions with SQL.',
  },
  {
    title: 'Improve it with new versions',
    text: 'Upload again to create v2, v3… Compare any two versions to see exactly what was added, removed or changed.',
  },
  {
    title: 'Publish when it’s ready',
    text: 'Publishing marks one checked version as the official one. Choose who can see it: just you, your organization, or everyone.',
  },
  {
    title: 'Share and connect',
    text: 'Send a private share link, give specific people access, or let other tools read it through the API with a key.',
  },
] as const;

export type TabKey = 'overview' | 'preview' | 'schema' | 'metadata' | 'validation' | 'versions' | 'query' | 'activity' | 'sharing';

export const TAB_TIPS: Record<TabKey, string> = {
  overview: 'A one-page summary of this dataset: how many concepts it has, what kinds, how trustworthy they are, and how they link together.',
  preview: 'Browse the concepts like rows in a spreadsheet. The statistics show, for each header field, how often it’s filled in and its most common values.',
  schema: 'Two views of structure: which header fields the concept files use, and the table columns the concepts document in their “# Schema” sections.',
  metadata: 'Facts about the bundle itself — its OKF version, change log and every file we stored, with a fingerprint (SHA-256) to prove nothing changed.',
  validation: 'Our automatic check. Red errors break the OKF rules and block publishing; yellow and blue items are friendly suggestions only.',
  versions: 'Every upload is saved as a new frozen version. Publish any checked version, or compare two to see what changed.',
  query: 'Ask questions about this dataset. Use the builder to filter and sort without code, or write SQL if you know it. Nothing here can change the data.',
  activity: 'A history of what happened to this dataset and who did it — uploads, checks, publishing, sharing and queries.',
  sharing: 'Decide who can see this dataset: only you, your organization, or everyone. You can also invite specific people or create a share link.',
};

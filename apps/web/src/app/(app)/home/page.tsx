'use client';

import { ArrowRight, Eye, GitCompare, Rocket, Share2, ShieldCheck, UploadCloud } from 'lucide-react';
import Link from 'next/link';
import { Term } from '@/components/help';
import { Button } from '@/components/ui/button';
import { GLOSSARY, type GlossaryKey, STEPS } from '@/lib/help';
import { useMe } from '@/lib/session';

const ICONS = [UploadCloud, ShieldCheck, Eye, GitCompare, Rocket, Share2];

export default function HowItWorksPage() {
  const { data: me } = useMe();
  return (
    <div className="space-y-12">
      <section className="okf-hero relative overflow-hidden rounded-3xl border px-6 py-12 md:px-12 md:py-16">
        <p className="mb-3 inline-flex items-center gap-2 rounded-full border bg-card/70 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
          <span className="size-1.5 rounded-full bg-success" /> How OKF Platform works
        </p>
        <h1 className="max-w-3xl text-3xl font-semibold tracking-tight md:text-5xl">
          Turn a folder of knowledge into a <span className="okf-gradient-text">trusted, searchable catalog</span>.
        </h1>
        <p className="mt-4 max-w-2xl text-base text-muted-foreground md:text-lg">
          Teams write down what their data means - what each table holds, how a metric is calculated, who checked it - using <Term k="okf">OKF</Term>, a
          simple open format of text files. Upload that folder here and we check it, organize it, and let you explore and share it safely.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href={me ? '/datasets/new' : '/signup'}>
              {me ? 'Upload a bundle' : 'Get started free'} <ArrowRight />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/catalog">Browse public datasets</Link>
          </Button>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold tracking-tight">From upload to sharing in six steps</h2>
        <p className="mt-1 text-sm text-muted-foreground">No setup needed - each step happens automatically or with one click.</p>
        <ol className="okf-stagger mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => {
            const Icon = ICONS[i]!;
            return (
              <li key={s.title} className="okf-lift relative rounded-2xl border bg-card p-5">
                <div className="mb-4 flex items-center justify-between">
                  <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-primary to-[oklch(0.6_0.2_300)] text-primary-foreground shadow-md">
                    <Icon className="size-5" />
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">Step {i + 1}</span>
                </div>
                <h3 className="font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.text}</p>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">What does a bundle look like?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Just folders and text files. Each file describes one <Term k="concept">concept</Term> and starts with a small header; the only required line is its{' '}
            <code className="rounded bg-muted px-1">type</code>.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-2xl border bg-card p-4 font-mono text-xs leading-relaxed">{`sales/
├── index.md            ← table of contents
├── tables/
│   └── orders.md       ← one concept
└── metrics/
    └── revenue.md      ← another concept`}</pre>
        </div>
        <pre className="overflow-x-auto rounded-2xl border bg-card p-4 font-mono text-xs leading-relaxed">{`---
type: BigQuery Table          ← required
title: Orders
description: One row per customer order.
tags: [sales, orders]
verified: { by: human:ana, at: 2026-07-01T00:00:00Z }
---

# Schema
| Column   | Type    | Description         |
|----------|---------|---------------------|
| order_id | STRING  | Unique order id.    |
| total    | NUMERIC | Order total in USD. |

Joined with [customers](/tables/customers.md).`}</pre>
      </section>

      <section>
        <h2 className="text-xl font-semibold tracking-tight">Words you’ll see</h2>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(GLOSSARY) as GlossaryKey[]).map((k) => (
            <div key={k} className="rounded-xl border bg-card p-4">
              <dt className="text-sm font-semibold">{GLOSSARY[k].term}</dt>
              <dd className="mt-1 text-sm text-muted-foreground">{GLOSSARY[k].text}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

'use client';

import { Lightbulb, X } from 'lucide-react';
import { Tooltip as T } from 'radix-ui';
import * as React from 'react';
import { GLOSSARY, type GlossaryKey, TAB_TIPS, type TabKey } from '@/lib/help';

const tipKey = (tab: TabKey) => `okf.tip.${tab}`;

/** One plain-language sentence at the top of a dataset tab; dismissible and remembered per browser. */
export function TabTip({ tab }: { tab: TabKey }) {
  const [hidden, setHidden] = React.useState(true);
  React.useEffect(() => {
    try {
      setHidden(localStorage.getItem(tipKey(tab)) === 'hidden');
    } catch {
      setHidden(false);
    }
  }, [tab]);
  if (hidden) return null;
  return (
    <div className="okf-enter mb-5 flex items-start gap-3 rounded-xl border border-primary/20 bg-gradient-to-r from-primary/8 to-transparent px-4 py-3 text-sm">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
        <Lightbulb className="size-3.5" />
      </span>
      <p className="flex-1 text-muted-foreground">
        <span className="font-medium text-foreground">What is this? </span>
        {TAB_TIPS[tab]}
      </p>
      <button
        aria-label="Hide this tip"
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(tipKey(tab), 'hidden');
          } catch {
            // storage unavailable: hidden for this page view only
          }
        }}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Underlined term with a plain-language definition on hover or focus. */
export function Term({ k, children }: { k: GlossaryKey; children?: React.ReactNode }) {
  const g = GLOSSARY[k];
  return (
    <T.Provider delayDuration={150}>
      <T.Root>
        <T.Trigger asChild>
          <span tabIndex={0} className="cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-4">
            {children ?? g.term}
          </span>
        </T.Trigger>
        <T.Portal>
          <T.Content sideOffset={6} className="okf-enter z-50 max-w-xs rounded-lg border bg-card px-3 py-2 text-xs leading-relaxed shadow-xl">
            <p className="mb-0.5 font-semibold text-foreground">{g.term}</p>
            <p className="text-muted-foreground">{g.text}</p>
            <T.Arrow className="fill-card" />
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}

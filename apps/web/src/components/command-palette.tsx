'use client';

import type { Page, SearchHitDTO } from '@okf/shared';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Dialog as D } from 'radix-ui';
import { Building2, Database, FileText, KeyRound, LayoutDashboard, LibraryBig, Moon, Plus, ScrollText, Search, Settings, Sun, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { applyTheme } from '@/components/theme-toggle';
import { api } from '@/lib/api';
import { useMe } from '@/lib/session';

const OpenCtx = React.createContext<(open: boolean) => void>(() => undefined);
/** Open the palette from anywhere (e.g. the sidebar search button). */
export const useCommandPalette = () => React.useContext(OpenCtx);

const itemClass =
  'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
const groupClass = '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground';

/** ⌘K / Ctrl+K palette: jump to pages, run actions, and search datasets and concepts. */
export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const router = useRouter();
  const { data: me } = useMe();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const datasets = useQuery({
    queryKey: ['palette', 'datasets', debounced],
    queryFn: () => api<Page<SearchHitDTO>>('/search', { query: { q: debounced, scope: 'datasets', pageSize: 5 } }),
    enabled: open && debounced.length > 1,
  });
  const concepts = useQuery({
    queryKey: ['palette', 'concepts', debounced],
    queryFn: () => api<Page<SearchHitDTO>>('/search', { query: { q: debounced, scope: 'concepts', pageSize: 5 } }),
    enabled: open && debounced.length > 1,
  });

  const go = (href: string) => {
    setOpen(false);
    setQ('');
    router.push(href);
  };
  const signedIn = !!me;
  const pages = [
    ...(signedIn ? [{ label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard }, { label: 'Datasets', href: '/datasets', icon: Database }] : []),
    { label: 'Catalog', href: '/catalog', icon: LibraryBig },
    { label: 'Search', href: '/search', icon: Search },
    ...(signedIn
      ? [
          { label: 'Organizations', href: '/organizations', icon: Building2 },
          { label: 'Profile', href: '/settings/profile', icon: Settings },
          { label: 'Members', href: '/settings/members', icon: Users },
          { label: 'API keys', href: '/settings/api-keys', icon: KeyRound },
          { label: 'Audit log', href: '/settings/audit-log', icon: ScrollText },
        ]
      : []),
  ];
  const conceptHref = (h: SearchHitDTO) => `/datasets/${h.dataset.id}/concepts/${h.concept!.conceptId.split('/').map(encodeURIComponent).join('/')}`;

  return (
    <OpenCtx.Provider value={setOpen}>
      {children}
      <D.Root open={open} onOpenChange={setOpen}>
        <D.Portal>
          <D.Overlay className="okf-enter fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
          <D.Content className="okf-enter fixed left-1/2 top-[15vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border bg-card shadow-2xl">
            <D.Title className="sr-only">Command palette</D.Title>
            <D.Description className="sr-only">Search datasets and concepts, or jump to a page.</D.Description>
            <Command shouldFilter={debounced.length < 2} loop label="Command palette">
              <div className="flex items-center gap-2 border-b px-3">
                <Search className="size-4 text-muted-foreground" />
                <Command.Input value={q} onValueChange={setQ} placeholder="Search datasets, concepts, pages…" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">esc</kbd>
              </div>
              <Command.List className="max-h-[60vh] overflow-y-auto p-2">
                <Command.Empty className="py-8 text-center text-sm text-muted-foreground">{datasets.isFetching || concepts.isFetching ? 'Searching…' : 'No results.'}</Command.Empty>
                {debounced.length > 1 && datasets.data?.data.length ? (
                  <Command.Group heading="Datasets" className={groupClass}>
                    {datasets.data.data.map((h) => (
                      <Command.Item key={h.dataset.id} value={`dataset-${h.dataset.id}`} onSelect={() => go(`/datasets/${h.dataset.id}`)} className={itemClass}>
                        <Database />
                        <span className="flex-1 truncate">{h.dataset.name}</span>
                        <span className="text-xs text-muted-foreground">{h.dataset.organization.name}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ) : null}
                {debounced.length > 1 && concepts.data?.data.length ? (
                  <Command.Group heading="Concepts" className={groupClass}>
                    {concepts.data.data.map((h) => (
                      <Command.Item key={`${h.dataset.id}-${h.concept!.conceptId}`} value={`concept-${h.dataset.id}-${h.concept!.conceptId}`} onSelect={() => go(conceptHref(h))} className={itemClass}>
                        <FileText />
                        <span className="flex-1 truncate">{h.concept!.title}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {h.concept!.type} · {h.dataset.name}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ) : null}
                {debounced.length > 1 ? (
                  <Command.Group heading="Search" className={groupClass}>
                    <Command.Item value="full-search" onSelect={() => go(`/search?q=${encodeURIComponent(debounced)}`)} className={itemClass}>
                      <Search /> Search everything for “{debounced}”
                    </Command.Item>
                  </Command.Group>
                ) : (
                  <>
                    {signedIn ? (
                      <Command.Group heading="Actions" className={groupClass}>
                        <Command.Item onSelect={() => go('/datasets/new')} className={itemClass}>
                          <Plus /> New dataset
                        </Command.Item>
                        <Command.Item onSelect={() => go('/organizations')} className={itemClass}>
                          <Building2 /> New organization
                        </Command.Item>
                        <Command.Item onSelect={() => go('/settings/api-keys')} className={itemClass}>
                          <KeyRound /> Create API key
                        </Command.Item>
                      </Command.Group>
                    ) : null}
                    <Command.Group heading="Go to" className={groupClass}>
                      {pages.map((p) => (
                        <Command.Item key={p.href} onSelect={() => go(p.href)} className={itemClass}>
                          <p.icon /> {p.label}
                        </Command.Item>
                      ))}
                    </Command.Group>
                    <Command.Group heading="Theme" className={groupClass}>
                      <Command.Item onSelect={() => (applyTheme('light'), setOpen(false))} className={itemClass}>
                        <Sun /> Light theme
                      </Command.Item>
                      <Command.Item onSelect={() => (applyTheme('dark'), setOpen(false))} className={itemClass}>
                        <Moon /> Dark theme
                      </Command.Item>
                    </Command.Group>
                  </>
                )}
              </Command.List>
            </Command>
          </D.Content>
        </D.Portal>
      </D.Root>
    </OpenCtx.Provider>
  );
}

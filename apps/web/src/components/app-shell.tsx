'use client';

import { Building2, ChevronsUpDown, Database, KeyRound, LayoutDashboard, LibraryBig, LogOut, ScrollText, Search, Settings, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { CommandPaletteProvider, useCommandPalette } from '@/components/command-palette';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/overlays';
import { useCurrentOrg, useMe, useSignOut } from '@/lib/session';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, auth: true },
  { href: '/datasets', label: 'Datasets', icon: Database, auth: true },
  { href: '/catalog', label: 'Catalog', icon: LibraryBig, auth: false },
  { href: '/search', label: 'Search', icon: Search, auth: false },
  { href: '/organizations', label: 'Organizations', icon: Building2, auth: true },
];
const SETTINGS = [
  { href: '/settings/profile', label: 'Profile', icon: Settings },
  { href: '/settings/members', label: 'Members', icon: Users },
  { href: '/settings/api-keys', label: 'API keys', icon: KeyRound },
  { href: '/settings/audit-log', label: 'Audit log', icon: ScrollText },
];

function NavLink({ href, label, icon: Icon }: { href: string; label: string; icon: React.ComponentType<{ className?: string }> }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors', active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
    >
      <Icon className="size-4" />
      {label}
    </Link>
  );
}

function OrgSwitcher() {
  const { org, orgs, setOrg } = useCurrentOrg();
  if (orgs.length === 0) {
    return (
      <Button asChild variant="outline" size="sm" className="w-full justify-start">
        <Link href="/organizations">
          <Building2 /> Create an organization
        </Link>
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left text-sm hover:bg-muted" aria-label="Switch organization">
          <span className="grid size-6 place-items-center rounded bg-primary/15 text-xs font-semibold text-primary">{org?.name.slice(0, 1).toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{org?.name}</span>
            <span className="block text-xs capitalize text-muted-foreground">{org?.role}</span>
          </span>
          <ChevronsUpDown className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {orgs.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => setOrg(o.id)}>
            <span className="flex-1 truncate">{o.name}</span>
            <span className="text-xs capitalize text-muted-foreground">{o.role}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/organizations">Manage organizations</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SearchButton() {
  const open = useCommandPalette();
  return (
    <button onClick={() => open(true)} className="mb-3 flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
      <Search className="size-4" />
      <span className="flex-1 text-left">Search…</span>
      <kbd className="rounded border bg-muted px-1.5 font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <CommandPaletteProvider>
      <Shell>{children}</Shell>
    </CommandPaletteProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: me } = useMe();
  const signOut = useSignOut();
  const signedIn = !!me;
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
        <Link href={signedIn ? '/dashboard' : '/catalog'} className="flex items-center gap-2 px-4 py-4">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">K</span>
          <span className="font-semibold tracking-tight">OKF Platform</span>
        </Link>
        {signedIn ? (
          <div className="px-3 pb-3">
            <OrgSwitcher />
          </div>
        ) : null}
        <div className="px-3">
          <SearchButton />
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3" aria-label="Main">
          {NAV.filter((n) => signedIn || !n.auth).map((n) => (
            <NavLink key={n.href} {...n} />
          ))}
          {signedIn ? (
            <>
              <p className="mt-5 mb-1 px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Settings</p>
              {SETTINGS.map((n) => (
                <NavLink key={n.href} {...n} />
              ))}
            </>
          ) : null}
        </nav>
        <div className="space-y-3 border-t p-3">
          <ThemeToggle />
          {me ? (
            <div className="flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-full bg-muted text-xs font-semibold">{me.user.name.slice(0, 2).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{me.user.name}</p>
                <p className="truncate text-xs text-muted-foreground">{me.user.email}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => void signOut()} aria-label="Sign out" title="Sign out">
                <LogOut />
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button asChild size="sm" className="flex-1">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild size="sm" variant="outline" className="flex-1">
                <Link href="/signup">Sign up</Link>
              </Button>
            </div>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-3 md:hidden">
          <Link href="/" className="font-semibold">
            OKF Platform
          </Link>
          <nav className="ml-auto flex gap-3 text-sm" aria-label="Mobile">
            {NAV.filter((n) => signedIn || !n.auth).map((n) => (
              <Link key={n.href} href={n.href} className="text-muted-foreground">
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <main key={pathname.split('/').slice(0, 3).join('/')} className="okf-enter mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

type Theme = 'system' | 'light' | 'dark';
const KEY = 'okf.theme';

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = React.useState<Theme>('system');
  React.useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setTheme(t === 'dark' || t === 'light' ? t : 'system');
  }, []);
  return [theme, (t) => (applyTheme(t), setTheme(t))];
}

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
];

/** Segmented light / system / dark switch. */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-md border bg-card p-0.5">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          role="radio"
          aria-checked={theme === value}
          title={label}
          onClick={() => setTheme(value)}
          className={cn('flex flex-1 items-center justify-center rounded px-2 py-1 transition-colors', theme === value ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          <Icon className="size-3.5" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('attestra.theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;

export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  useEffect(() => {
    setTheme((document.documentElement.getAttribute('data-theme') as 'light' | 'dark') ?? 'light');
  }, []);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.setAttribute('data-theme', next);
        try {
          localStorage.setItem('attestra.theme', next);
        } catch {
          // storage blocked: the theme still switches for this page
        }
        setTheme(next);
      }}
      className="grid size-9 place-items-center rounded-lg border border-line bg-panel text-soft transition hover:border-brand-400/50 hover:text-accent"
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

'use client';

import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';

export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('attestra.theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;

function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, () => document.documentElement.getAttribute('data-theme') as 'light' | 'dark' | null, () => null);
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
      }}
      className="grid size-9 place-items-center rounded-lg border border-line bg-panel text-soft transition-colors hover:border-line-strong hover:text-fg"
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const TABS = [
  { href: '/attestations', label: 'Attestations' },
  { href: '/schemas', label: 'Schemas' },
  { href: '/authorities', label: 'Authorities' },
  { href: '/agents', label: 'Agents' },
  { href: '/audit-log', label: 'Audit log' },
];

export function ExplorerShell({ title, intro, children, actions }: { title: ReactNode; intro?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  const path = usePathname();
  return (
    <div>
      <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
        <nav className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0" aria-label="Explorer">
          {TABS.map((t) => {
            const on = path === t.href || path.startsWith(`${t.href}/`);
            return (
              <Link key={t.href} href={t.href} aria-current={on ? 'page' : undefined} className={`-mb-px shrink-0 border-b-2 px-3 py-2.5 text-[13.5px] font-medium transition-colors first:pl-0 ${on ? 'border-brand-600 text-fg dark:border-brand-400' : 'border-transparent text-soft hover:text-fg'}`}>
                {t.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[1.75rem] font-semibold tracking-tight text-fg sm:text-[2.1rem]">{title}</h1>
            {intro && <p className="mt-2 max-w-2xl text-[14.5px] text-soft">{intro}</p>}
          </div>
          {actions}
        </div>
        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}

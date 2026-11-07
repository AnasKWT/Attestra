'use client';

import { Activity, Bot, FileCheck2, Landmark, Layers } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const TABS = [
  { href: '/attestations', label: 'Attestations', icon: FileCheck2 },
  { href: '/schemas', label: 'Schemas', icon: Layers },
  { href: '/authorities', label: 'Authorities', icon: Landmark },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/audit-log', label: 'Audit log', icon: Activity },
];

export function ExplorerShell({ title, intro, children, actions }: { title: ReactNode; intro?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  const path = usePathname();
  return (
    <div className="relative">
      <div className="spotlight pointer-events-none absolute inset-x-0 top-0 h-80 opacity-70" />
      <div className="relative mx-auto max-w-7xl px-4 pb-16 pt-10 sm:px-6">
        <nav className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-panel p-1 shadow-panel" aria-label="Explorer">
          {TABS.map((t) => {
            const on = path === t.href || path.startsWith(`${t.href}/`);
            return (
              <Link key={t.href} href={t.href} className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-[13.5px] font-medium transition ${on ? 'bg-accent-soft text-accent' : 'text-soft hover:bg-soft hover:text-fg'}`}>
                <t.icon className="size-4" />
                {t.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold text-fg sm:text-[2.2rem]">{title}</h1>
            {intro && <p className="mt-2 max-w-2xl text-[14.5px] text-soft">{intro}</p>}
          </div>
          {actions}
        </div>
        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}

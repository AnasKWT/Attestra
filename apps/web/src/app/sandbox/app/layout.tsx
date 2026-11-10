'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { GROUPS, TOOLS } from '@/lib/tools';

export default function SandboxLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div>
      <div className="mx-auto flex max-w-[1400px] gap-8 px-4 py-8 sm:px-6">
        <aside className="sticky top-24 hidden h-[calc(100vh-7rem)] w-60 shrink-0 overflow-y-auto pr-2 lg:block" aria-label="Sandbox tools">
          <Link href="/sandbox/app" className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[13.5px] font-semibold ${path === '/sandbox/app' ? 'bg-soft text-fg' : 'text-fg hover:bg-soft'}`}>
            All tools
          </Link>
          {GROUPS.map((g) => (
            <div key={g} className="mb-4">
              <p className="px-3 pb-1.5 text-[12px] font-medium text-mute">{g}</p>
              {TOOLS.filter((t) => t.group === g).map((t) => {
                const href = `/sandbox/app/${t.slug}`;
                const on = path === href;
                return (
                  <Link key={t.slug} href={href} className={`relative flex items-center rounded-lg px-3 py-1.5 text-[13px] transition ${on ? 'bg-soft font-medium text-fg' : 'text-soft hover:text-fg'}`}>
                    {t.title}
                  </Link>
                );
              })}
            </div>
          ))}
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

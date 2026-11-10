'use client';

import { Menu, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Logo } from '../brand/Logo';
import { ConnectButton } from '../wallet/ConnectButton';
import { ThemeToggle } from './ThemeToggle';

const NAV = [
  { href: '/products/schema', label: 'Schemas' },
  { href: '/products/attestation', label: 'Attestations' },
  { href: '/near', label: 'Only on NEAR' },
  { href: '/attestations', label: 'Explorer', match: ['/attestations', '/schemas', '/authorities', '/agents', '/audit-log'] },
  { href: '/sandbox', label: 'Sandbox' },
  { href: '/docs', label: 'Docs' },
];

export function Navbar() {
  const path = usePathname();
  const router = useRouter();
  const [scrolled, setScrolled] = useState(false);
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === path;
  const setOpen = (fn: (o: boolean) => boolean) => setOpenAt(fn(open) ? path : null);
  const [q, setQ] = useState('');

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  const active = (n: (typeof NAV)[number]) => (n.match ?? [n.href]).some((m) => path === m || path.startsWith(`${m}/`));

  return (
    <header className={`fixed inset-x-0 top-0 z-40 transition-all duration-300 ${scrolled ? 'border-b border-line bg-[color-mix(in_srgb,var(--bg)_94%,transparent)] backdrop-blur-md' : 'border-b border-transparent'}`}>
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Attestra home" className="shrink-0">
          <Logo />
        </Link>
        <nav className="ml-4 hidden items-center gap-0.5 lg:flex" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n) ? 'page' : undefined}
              className={`relative rounded-md px-3 py-2 text-[13.5px] font-medium transition-colors ${active(n) ? 'text-fg' : 'text-soft hover:text-fg'}`}
            >
              {n.label}
              {active(n) && <span className="absolute inset-x-3 -bottom-[13px] h-px bg-fg" />}
            </Link>
          ))}
        </nav>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
          }}
          className="ml-auto hidden w-56 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 transition-colors focus-within:border-line-strong xl:flex"
        >
          <Search className="size-3.5 text-mute" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="UID, account or schema" aria-label="Search" className="h-8 w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-mute" />
        </form>
        <div className="ml-auto flex items-center gap-2 xl:ml-0">
          <ThemeToggle />
          <div className="hidden sm:block">
            <ConnectButton />
          </div>
          <button onClick={() => setOpen((o) => !o)} className="grid size-9 place-items-center rounded-lg border border-line bg-panel text-soft lg:hidden" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open}>
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-line bg-[var(--bg)] lg:hidden">
          <nav className="mx-auto grid max-w-7xl gap-1 px-4 py-3" aria-label="Mobile">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className={`rounded-lg px-3 py-2.5 text-[14px] font-medium ${active(n) ? 'bg-soft text-fg' : 'text-soft hover:bg-soft hover:text-fg'}`}>
                {n.label}
              </Link>
            ))}
            <Link href="/search" className="rounded-lg px-3 py-2.5 text-[14px] font-medium text-fg hover:bg-soft">
              Search
            </Link>
            <div className="px-1 pt-2 sm:hidden">
              <ConnectButton />
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}

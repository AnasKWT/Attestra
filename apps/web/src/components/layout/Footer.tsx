import Link from 'next/link';
import { AUTHOR, NETWORK, REPO_URL } from '@/lib/config';
import { Logo } from '../brand/Logo';

const COLS = [
  { title: 'Product', links: [['Schemas', '/products/schema'], ['Attestations', '/products/attestation'], ['Only on NEAR', '/near'], ['About', '/about']] },
  { title: 'Explore', links: [['Attestations', '/attestations'], ['Schemas', '/schemas'], ['Authorities', '/authorities'], ['Agents', '/agents'], ['Audit log', '/audit-log'], ['Status', '/status']] },
  { title: 'Build', links: [['Sandbox', '/sandbox/app'], ['Docs', '/docs'], ['SDK', '/docs#sdk'], ['CLI', '/docs#cli'], ['MCP server', '/docs#mcp'], ['llms.txt', '/llms.txt']] },
] as const;

export function Footer() {
  return (
    <footer className="relative mt-24 border-t border-line bg-soft">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-500/50 to-transparent" />
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-[13.5px] leading-relaxed text-soft">The trust layer for NEAR: verifiable facts about people, wallets on any chain, and AI agents.</p>
          <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-[12px] text-soft">
            <span className="size-1.5 rounded-full bg-emerald-500" /> Running on NEAR {NETWORK}
          </p>
        </div>
        {COLS.map((c) => (
          <div key={c.title}>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-mute">{c.title}</p>
            <ul className="mt-4 space-y-2.5">
              {c.links.map(([label, href]) => (
                <li key={href}>
                  <Link href={href} className="text-[13.5px] text-soft transition hover:text-accent">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-5 text-[12.5px] text-mute sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            Built by {AUTHOR}. MIT licensed. Source: {REPO_URL.startsWith('http') ? <a className="hover:text-accent" href={REPO_URL}>{REPO_URL.replace('https://', '')}</a> : REPO_URL}
          </p>
          <p>Contracts verifiable with near contract verify. Light client proofs checked in your browser.</p>
        </div>
      </div>
    </footer>
  );
}

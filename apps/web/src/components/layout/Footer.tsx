import Link from 'next/link';
import { AUTHOR, AUTHOR_URL, NETWORK, REPO_URL } from '@/lib/config';
import { Logo } from '../brand/Logo';

const COLS = [
  { title: 'Product', links: [['Schemas', '/products/schema'], ['Attestations', '/products/attestation'], ['Only on NEAR', '/near'], ['About', '/about']] },
  { title: 'Explore', links: [['Attestations', '/attestations'], ['Schemas', '/schemas'], ['Authorities', '/authorities'], ['Agents', '/agents'], ['Audit log', '/audit-log'], ['Status', '/status']] },
  { title: 'Build', links: [['Sandbox', '/sandbox/app'], ['Docs', '/docs'], ['SDK', '/docs#sdk'], ['CLI', '/docs#cli'], ['MCP server', '/docs#mcp'], ['llms.txt', '/llms.txt']] },
] as const;

export function Footer() {
  return (
    <footer className="mt-24 border-t border-line bg-soft">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-[13.5px] leading-relaxed text-soft">The trust layer for NEAR: verifiable facts about people, wallets on any chain, and AI agents.</p>
          <p className="mt-5 text-[12.5px] text-mute">
            Network: <span className="font-mono text-soft">NEAR {NETWORK}</span>
          </p>
        </div>
        {COLS.map((c) => (
          <div key={c.title}>
            <p className="text-[13px] font-medium text-fg">{c.title}</p>
            <ul className="mt-4 space-y-2.5">
              {c.links.map(([label, href]) => (
                <li key={href}>
                  <Link href={href} className="text-[13.5px] text-soft transition-colors hover:text-fg">
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
            Built by {AUTHOR_URL ? <a className="hover:text-fg" href={AUTHOR_URL}>{AUTHOR}</a> : AUTHOR}. MIT licensed. Source: {REPO_URL.startsWith('http') ? <a className="hover:text-fg" href={REPO_URL}>{REPO_URL.replace('https://', '')}</a> : REPO_URL}
          </p>
          <p>Contracts verifiable with near contract verify. Light client proofs checked in your browser.</p>
        </div>
      </div>
    </footer>
  );
}

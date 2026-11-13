import { CheckCircle2, Circle } from 'lucide-react';
import { PageHero } from '@/components/marketing/PageHero';
import { SectionHeading } from '@/components/ui/primitives';
import { AUTHOR, REPO_URL } from '@/lib/config';

export const metadata = { title: 'About' };

const ROADMAP = [
  { when: 'Now, on testnet', done: true, items: ['Seven Rust contracts with reproducible builds', 'SDK, CLI and MCP server', 'Explorer, sandbox and agent chat', 'Private AI checks, EVM and Solana facts, Know Your Agent with function-call keys, x402 verification, light client proofs', 'Sputnik DAOs as attesters: membership credentials issued by proposal and council vote'] },
  { when: 'Next', done: false, items: ['Independent audit of the contracts', 'Mainnet deployment with native USDC for paid verification', 'Listing the verification agent on the NEAR AI Agent Market', 'Governance by a Sputnik DAO for authority verification'] },
  { when: 'Later', done: false, items: ['NEP-655 universal accounts for passkey subjects as SDK support lands', 'More foreign chains as the MPC network enables them', 'Selective disclosure: prove one field of an attestation without the others', 'Attestation-gated access for NEAR Intents and attestation-weighted DAO voting'] },
];

export default function About() {
  return (
    <>
      <PageHero eyebrow="About" title={<>Trust you can read <span className="text-mute">from any contract.</span></>} intro="Attestra is an open protocol for verifiable facts on NEAR: about people, wallets on any chain and AI agents. It is MIT licensed, and every claim it makes can be checked on chain." />
      <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6">
        <div>
          <SectionHeading eyebrow="Roadmap" title="Where it is going." />
        </div>
        <div className="relative mt-10 space-y-6 border-l border-line pl-8">
          {ROADMAP.map((r) => (
            <div key={r.when}>
              <div className="relative">
                <span className={`absolute -left-[36px] top-[8px] size-[9px] rounded-full border ${r.done ? 'border-brand-600 bg-brand-600' : 'border-line-strong bg-panel'}`} />
                <h3 className="text-lg font-semibold text-fg">{r.when}</h3>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {r.items.map((it) => (
                    <li key={it} className="flex items-start gap-2.5 rounded-lg border border-line bg-panel px-3.5 py-2.5 text-[13.5px] text-soft">
                      {r.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="done" /> : <Circle className="mt-0.5 size-4 shrink-0 text-mute" aria-label="planned" />}
                      {it}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
        <div>
          <div className="mt-16 rounded-xl border border-line bg-panel p-6">
            <h3 className="text-lg font-semibold text-fg">Who builds it</h3>
            <p className="mt-2 text-[14px] text-soft">Built by {AUTHOR}. Source code: {REPO_URL}.</p>
          </div>
        </div>
      </section>
    </>
  );
}

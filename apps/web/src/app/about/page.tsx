import { CheckCircle2, Circle } from 'lucide-react';
import { PageHero } from '@/components/marketing/PageHero';
import { Reveal } from '@/components/ui/Reveal';
import { SectionHeading } from '@/components/ui/primitives';
import { AUTHOR, REPO_URL } from '@/lib/config';

export const metadata = { title: 'About' };

const ROADMAP = [
  { when: 'Now, on testnet', done: true, items: ['Seven Rust contracts with reproducible builds', 'SDK, CLI and MCP server', 'Explorer, sandbox and agent chat', 'Private AI checks, EVM and Solana facts, Know Your Agent with function-call keys, x402 verification, light client proofs'] },
  { when: 'Next', done: false, items: ['Independent audit of the contracts', 'Mainnet deployment with native USDC for paid verification', 'Listing the verification agent on the NEAR AI Agent Market', 'Governance by a DAO for authority verification'] },
  { when: 'Later', done: false, items: ['NEP-655 universal accounts for passkey subjects as SDK support lands', 'More foreign chains as the MPC network enables them', 'Selective disclosure: prove one field of an attestation without the others', 'Attestation-gated access for NEAR Intents and Sputnik DAO proposals'] },
];

export default function About() {
  return (
    <>
      <PageHero eyebrow="About" title={<>Trust you can read <span className="text-gradient">from any contract.</span></>} intro="Attestra is an open protocol for verifiable facts on NEAR: about people, wallets on any chain and AI agents. It is MIT licensed, and every claim it makes can be checked on chain." />
      <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6">
        <Reveal>
          <SectionHeading eyebrow="Roadmap" title="Where it is going." />
        </Reveal>
        <div className="relative mt-10 space-y-6 border-l border-line pl-8">
          {ROADMAP.map((r, i) => (
            <Reveal key={r.when} delay={i * 80}>
              <div className="relative">
                <span className={`absolute -left-[41px] top-1 grid size-5 place-items-center rounded-full border-2 ${r.done ? 'border-brand-500 bg-brand-500 text-white' : 'border-line-strong bg-panel'}`}>
                  {r.done && <CheckCircle2 className="size-3" />}
                </span>
                <h3 className="text-lg font-semibold text-fg">{r.when}</h3>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {r.items.map((it) => (
                    <li key={it} className="flex items-start gap-2 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-[13.5px] text-soft shadow-panel">
                      {r.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <Circle className="mt-0.5 size-4 shrink-0 text-mute" />}
                      {it}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <div className="mt-16 rounded-2xl border border-line bg-panel p-6 shadow-panel">
            <h3 className="text-lg font-semibold text-fg">Who builds it</h3>
            <p className="mt-2 text-[14px] text-soft">Built by {AUTHOR}. Source code: {REPO_URL}.</p>
          </div>
        </Reveal>
      </section>
    </>
  );
}

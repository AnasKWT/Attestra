import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/primitives';
import { GROUPS, TOOLS } from '@/lib/tools';

export const metadata = { title: 'Sandbox' };

const GROUP_INTRO: Record<string, string> = {
  Core: 'Schemas, attestations and authorities.',
  Delegation: 'Issue for someone else with NEP-413 signatures.',
  Resolvers: 'Rules that run before an attestation is stored.',
  Data: 'Encode, decode and list.',
  Retrieval: 'Find anything.',
  'NEAR native': 'Credentials, scheduling, multisig, staking, large schemas and proofs.',
  'Only on NEAR': 'Verifiable AI, Chain Signatures, agents, x402 and gasless issuing.',
  Agent: 'Natural language over the whole protocol.',
};

export default function SandboxHome() {
  return (
    <div>
      <h1 className="text-3xl font-semibold text-fg sm:text-[2.2rem]">Sandbox</h1>
      <p className="mt-2 max-w-2xl text-[15px] text-soft">Every Attestra feature as a tool, running against the live NEAR testnet contracts. Reads need nothing; writes need a NEAR wallet or a passkey.</p>
      <div className="mt-10 space-y-10">
        {GROUPS.map((g) => (
          <section key={g}>
            <div className="mb-4 flex items-end gap-3">
              <h2 className="text-lg font-semibold text-fg">{g}</h2>
              <p className="text-[13px] text-mute">{GROUP_INTRO[g]}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {TOOLS.filter((t) => t.group === g).map((t) => (
                <Link key={t.slug} href={`/sandbox/app/${t.slug}`} className={`group relative overflow-hidden rounded-xl border bg-panel p-4 shadow-panel transition hover:-translate-y-0.5 hover:border-brand-400/50 hover:shadow-float ${g === 'Only on NEAR' ? 'border-brand-500/30' : 'border-line'}`}>
                  {g === 'Only on NEAR' && <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-500 to-transparent" />}
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-display text-[15px] font-semibold text-fg">{t.title}</p>
                    <ArrowRight className="size-4 text-mute transition group-hover:translate-x-0.5 group-hover:text-accent" />
                  </div>
                  <p className="mt-1 text-[13px] leading-relaxed text-soft">{t.blurb}</p>
                  <div className="mt-3">{t.write ? <Badge tone="warn">writes</Badge> : <Badge tone="ok">read only</Badge>}</div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

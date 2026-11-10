import { ArrowRight, Bot, Coins, Fingerprint, Link2, ScrollText, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { CheckerModeBadge } from '@/components/marketing/CheckerMode';
import { PageHero } from '@/components/marketing/PageHero';
import { Reveal } from '@/components/ui/Reveal';
import { ButtonLink } from '@/components/ui/primitives';

export const metadata = { title: 'Only on NEAR' };

const FEATURES = [
  {
    icon: Sparkles,
    title: 'Private facts, checked by verifiable AI',
    primitive: 'NEAR AI Cloud (TEE inference, end-to-end encryption, signed responses) + OutLayer TEE',
    flow: ['Your browser encrypts the evidence to the attested model key.', 'The checker adds the rule, calls the verifiable model, checks its signature and signs a verdict: in OutLayer mode inside an OutLayer TEE with a key bound to its build, in local mode inside the Attestra agent with a bootstrap key.', 'The verdicts contract checks the checker signature and the model signature (ed25519 or secp256k1) and attests a pass with only the evidence hash.'],
    trust: 'Proven: the model answered in a TEE and a checker key the verdicts contract trusts signed the verdict; in OutLayer mode that key is bound to the published checker build, in local mode it is held by the agent operator. Not proven: that free-text evidence is genuine; GitHub rules close that gap by having the checker fetch the data itself.',
    href: '/sandbox/app/private-check',
    checkerMode: true,
  },
  {
    icon: Link2,
    title: 'Facts about any chain, without an oracle',
    primitive: 'Chain Signatures foreign-transaction verification (MPC verify_foreign_transaction)',
    flow: ['The verdicts contract asks the MPC signer to verify a transaction and extract a log.', 'MPC nodes read a quorum of RPC providers inside TEEs and threshold-sign the payload.', 'The contract recomputes the payload hash and checks the signature with ecrecover against the network key.'],
    trust: 'Proven: the MPC network attested the log at finality. Trusted: the MPC threshold and its RPC quorum. Testnet reads the test networks (Base Sepolia, Arbitrum Sepolia and others).',
    href: '/sandbox/app/cross-chain',
  },
  {
    icon: Bot,
    title: 'Know Your Agent',
    primitive: 'Attestations, contract-enforced delegation, function-call access keys',
    flow: ['The owner attests an identity about the agent account: owner, model, capabilities, endpoint.', 'The owner delegates attesting rights with a scope, a use limit and an expiry the contract enforces.', 'Clients review the agent; profiles average active reviews.'],
    trust: 'Everything is an attestation anyone can verify; delegation limits are enforced on chain, not by the agent.',
    href: '/agents',
  },
  {
    icon: Coins,
    title: 'Verification as a paid service',
    primitive: 'x402 on NEAR: NEP-366 delegate action carrying a NEP-141 ft_transfer',
    flow: ['The agent answers 402 with the price.', 'The client signs one ft_transfer as a delegate action.', 'The agent checks the signed transfer, settles it on chain from its own account, then answers.'],
    trust: 'The payer needs the token and no NEAR. Testnet uses a free test token; mainnet uses native USDC.',
    href: '/sandbox/app/paid-verify',
  },
  {
    icon: Fingerprint,
    title: 'Gasless issuing and passkey subjects',
    primitive: 'NEP-413 signed requests, NEP-366 meta transactions, NEP-145 storage, WebAuthn PRF',
    flow: ['An issuer signs a request off chain; the relayer submits it within budgets and an allowlist.', 'A passkey derives an ed25519 key inside the authenticator; its implicit account claims and views credentials.', 'Storage is paid from balances anyone can fund.'],
    trust: 'The relayer cannot change a signed request: the contract checks the signature, the deadline and a one-time nonce.',
    href: '/sandbox/app/gasless',
  },
  {
    icon: ScrollText,
    title: 'A trustless audit trail',
    primitive: 'NEP-297 events + light client proofs (EXPERIMENTAL_light_client_proof)',
    flow: ['Every change logs a NEP-297 event in its receipt.', 'The browser checks validator approvals on a light client block (more than 2/3 of stake).', 'It walks the merkle paths from the receipt outcome to that block.'],
    trust: 'Trusted: the epoch block producer list as the RPC reports it. Not trusted: the indexer or the RPC for the outcome itself.',
    href: '/sandbox/app/verify-proof',
  },
];

export default function NearPage() {
  return (
    <>
      <PageHero eyebrow="Only on NEAR" title={<>Six things a registry <span className="text-gradient">elsewhere cannot do.</span></>} intro="Each feature is built on a NEAR primitive as its core. Here is how each works, what it proves, and what it does not.">
        <ButtonLink href="/sandbox/app" size="lg">Try them <ArrowRight className="size-4" /></ButtonLink>
      </PageHero>
      <section className="mx-auto max-w-6xl space-y-6 px-4 py-20 sm:px-6">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={i * 40}>
            <article className="ring-gradient grid gap-6 rounded-3xl bg-panel p-6 shadow-panel md:grid-cols-[1fr_1.2fr] md:p-8">
              <div>
                <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-b from-brand-400 to-brand-600 text-white shadow"><f.icon className="size-5" /></span>
                <h2 className="mt-5 text-2xl font-semibold text-fg">{f.title}</h2>
                <p className="mt-2 font-mono text-[12px] leading-relaxed text-accent">{f.primitive}</p>
                <Link href={f.href} className="mt-5 inline-flex items-center gap-1.5 text-[13.5px] font-medium text-accent hover:underline">Open it <ArrowRight className="size-3.5" /></Link>
              </div>
              <div className="space-y-4">
                <ol className="space-y-2.5">
                  {f.flow.map((s, j) => (
                    <li key={j} className="flex gap-3 text-[14px] text-soft">
                      <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line bg-soft font-mono text-[11px] text-fg">{j + 1}</span>
                      {s}
                    </li>
                  ))}
                </ol>
                <p className="rounded-xl border border-line bg-panel-2 p-3.5 text-[13px] leading-relaxed text-soft"><span className="font-semibold text-fg">Trust model. </span>{f.trust}</p>
                {'checkerMode' in f && f.checkerMode && <p className="flex flex-wrap items-center gap-2 text-[13px] text-soft">Checker mode right now: <CheckerModeBadge /></p>}
              </div>
            </article>
          </Reveal>
        ))}
      </section>
    </>
  );
}

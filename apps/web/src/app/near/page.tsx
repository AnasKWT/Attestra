import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { CheckerModeBadge } from '@/components/marketing/CheckerMode';
import { PageHero } from '@/components/marketing/PageHero';
import { ButtonLink } from '@/components/ui/primitives';

export const metadata = { title: 'Only on NEAR' };

const FEATURES = [
  {
    title: 'Private facts, checked by verifiable AI',
    primitive: 'NEAR AI Cloud (TEE inference, end-to-end encryption, signed responses) + OutLayer TEE',
    flow: ['Your browser encrypts the evidence to the attested model key.', 'The checker adds the rule, calls the verifiable model, checks its signature and signs a verdict: in OutLayer mode inside an OutLayer TEE with a key bound to its build, in local mode inside the Attestra agent with a bootstrap key.', 'The verdicts contract checks the checker signature and the model signature (ed25519 or secp256k1) and attests a pass with only the evidence hash.'],
    trust: 'Proven: the model answered in a TEE and a checker key the verdicts contract trusts signed the verdict; in OutLayer mode that key is bound to the published checker build, in local mode it is held by the agent operator. Not proven: that free-text evidence is genuine; GitHub rules close that gap by having the checker fetch the data itself.',
    href: '/sandbox/app/private-check',
    checkerMode: true,
  },
  {
    title: 'Facts about any chain, without an oracle',
    primitive: 'Chain Signatures foreign-transaction verification (MPC verify_foreign_transaction)',
    flow: ['The verdicts contract asks the MPC signer to verify a transaction and extract a log (EVM chains) or an inner instruction (Solana).', 'MPC nodes read a quorum of RPC providers inside TEEs and threshold-sign the payload.', 'The contract recomputes the payload hash and checks the signature with ecrecover against the network key.'],
    trust: 'Proven: the MPC network attested the log or instruction at finality. Trusted: the MPC threshold and its RPC quorum. Testnet reads the test networks (Solana devnet, Base Sepolia, Arbitrum Sepolia and others).',
    href: '/sandbox/app/cross-chain',
  },
  {
    title: 'Know Your Agent',
    primitive: 'Attestations, contract-enforced delegation, function-call access keys',
    flow: ['The owner attests an identity about the agent account: owner, model, capabilities, endpoint.', 'The owner delegates attesting rights with a scope, a use limit and an expiry the contract enforces, or gives the agent a function-call access key that can only attest and revoke within a gas allowance.', 'Clients review the agent; profiles average active reviews.'],
    trust: 'Everything is an attestation anyone can verify; delegation limits are enforced on chain, not by the agent.',
    href: '/agents',
  },
  {
    title: 'Verification as a paid service',
    primitive: 'x402 on NEAR: NEP-366 delegate action carrying a NEP-141 ft_transfer',
    flow: ['The agent answers 402 with the price.', 'The client signs one ft_transfer as a delegate action.', 'The agent checks the signed transfer, settles it on chain from its own account, then answers.'],
    trust: 'The payer needs the token and no NEAR. Testnet uses a free test token; mainnet uses native USDC.',
    href: '/sandbox/app/paid-verify',
  },
  {
    title: 'Gasless issuing and passkey subjects',
    primitive: 'NEP-413 signed requests, NEP-366 meta transactions, NEP-145 storage, WebAuthn PRF',
    flow: ['An issuer signs a request off chain; the relayer submits it within budgets and an allowlist.', 'A passkey derives an ed25519 key inside the authenticator; its implicit account claims and views credentials.', 'Storage is paid from balances anyone can fund.'],
    trust: 'The relayer cannot change a signed request: the contract checks the signature, the deadline and a one-time nonce.',
    href: '/sandbox/app/gasless',
  },
  {
    title: 'Credentials issued by a DAO vote',
    primitive: 'Sputnik DAO v2 FunctionCall proposals, NEP-145 storage balances',
    flow: ['A member proposes that the DAO attest a claim, such as their membership, and pays the proposal bond.', 'The council votes; the deciding approval makes the DAO account call attest itself, in the same transaction.', 'The attestation names the DAO as its attester, and the explorer links it to the proposal and the votes that issued it.'],
    trust: 'No single member can issue in the DAO\'s name: the DAO\'s policy and its council vote are enforced by the Sputnik contract. On the deployment DAO the keeper votes on membership requests by a fixed rule, and everything else waits for a human vote.',
    href: '/sandbox/app/dao-attestation',
  },
  {
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
      <PageHero eyebrow="Only on NEAR" title={<>Seven things a registry <span className="text-mute">elsewhere cannot do.</span></>} intro="Each feature is built on a NEAR primitive as its core. Here is how each works, what it proves, and what it does not.">
        <ButtonLink href="/sandbox/app" size="lg">Try them <ArrowRight className="size-4" /></ButtonLink>
      </PageHero>
      <section className="mx-auto max-w-6xl space-y-5 px-4 py-20 sm:px-6">
        {FEATURES.map((f, i) => (
          <article key={f.title} className="grid gap-8 rounded-xl border border-line bg-panel p-6 shadow-panel md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:p-8">
            <div>
              <p className="font-mono text-[12px] text-mute">{String(i + 1).padStart(2, '0')}</p>
              <h2 className="mt-3 text-[1.5rem] font-semibold leading-snug tracking-tight text-fg">{f.title}</h2>
              <p className="mt-3 font-mono text-[12px] leading-relaxed text-soft">{f.primitive}</p>
              <Link href={f.href} className="mt-5 inline-flex items-center gap-1.5 text-[14px] font-medium text-accent underline-offset-4 hover:underline">Open it <ArrowRight className="size-3.5" /></Link>
            </div>
            <div className="space-y-5">
              <ol className="space-y-3">
                {f.flow.map((s, j) => (
                  <li key={j} className="grid grid-cols-[20px_1fr] gap-3 text-[14px] leading-relaxed text-soft">
                    <span className="pt-px font-mono text-[12px] text-mute">{j + 1}.</span>
                    {s}
                  </li>
                ))}
              </ol>
              <p className="border-t border-line pt-4 text-[13.5px] leading-relaxed text-soft"><span className="font-semibold text-fg">Trust model. </span>{f.trust}</p>
              {'checkerMode' in f && f.checkerMode && <p className="flex flex-wrap items-center gap-2 text-[13px] text-soft">Checker mode right now: <CheckerModeBadge /></p>}
            </div>
          </article>
        ))}
      </section>
    </>
  );
}

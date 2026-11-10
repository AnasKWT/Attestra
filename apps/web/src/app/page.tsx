import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { HeroVisual } from '@/components/marketing/HeroVisual';
import { LiveStats } from '@/components/marketing/LiveStats';
import { CodeTabs } from '@/components/ui/Code';
import { ButtonLink, Eyebrow, SectionHeading } from '@/components/ui/primitives';
import { TOOLS } from '@/lib/tools';

const PRIMITIVES = ['NEAR AI Cloud', 'OutLayer TEE', 'Chain Signatures', 'NEP-413 signatures', 'NEP-366 meta transactions', 'NEP-171 credentials', 'NEP-145 storage', 'NEP-297 events', 'Light client proofs', 'x402 payments', 'Passkeys', 'NEAR Connect'];

const STEPS = [
  { title: 'Define a schema', body: 'Name the fields of a claim once. Its UID is derived from the definition, so anyone can compute it.', code: 'string name, u8 level' },
  { title: 'Attest', body: 'An authority issues a claim about a NEAR account or a wallet on any chain. Delegates, agents and multisigs can issue too.', code: 'attest(schema, subject, data)' },
  { title: 'Resolve', body: 'Resolvers add rules: whitelists, fees, token gates, rewards, or a pipeline of all of them. A refusal rolls everything back.', code: 'pending → created | rejected' },
  { title: 'Verify anywhere', body: 'Read it from the contract, decode it with the SDK, or prove its event is final with a light client proof in the browser.', code: 'isValid(uid) → true' },
];

const NEAR_FEATURES = [
  {
    primitive: 'NEAR AI Cloud, OutLayer TEE',
    title: 'Private facts, checked by verifiable AI',
    body: 'Evidence is encrypted to a NEAR AI Cloud model inside a TEE. A checker (an OutLayer TEE component, or the agent with a bootstrap key in local mode) checks it against the rule and signs a verdict; only its hash goes on chain.',
    href: '/sandbox/app/private-check',
  },
  {
    primitive: 'Chain Signatures',
    title: 'Facts about any chain, without an oracle',
    body: 'The NEAR MPC network verifies a transaction on Solana, Base, Arbitrum or Polygon and the contract checks its signature itself.',
    href: '/sandbox/app/cross-chain',
  },
  {
    primitive: 'Function-call access keys',
    title: 'Know Your Agent',
    body: 'Agents get an owner-signed identity, scoped delegation with limits and expiry, and reviews from the people and agents who hired them.',
    href: '/agents',
  },
  {
    primitive: 'x402, NEP-366, NEP-141',
    title: 'Verification as a paid service',
    body: 'Agents buy "verify a claim" and "check an agent" per call over x402 on NEAR, paying with a signed token transfer and no NEAR for gas.',
    href: '/sandbox/app/paid-verify',
  },
  {
    primitive: 'NEP-413, NEP-366, passkeys',
    title: 'Gasless issuing, passkey subjects',
    body: 'Issuers sign requests and the relayer pays. Subjects with no wallet claim and view credentials with a passkey.',
    href: '/sandbox/app/gasless',
  },
  {
    primitive: 'NEP-297, light client proofs',
    title: 'A trustless audit trail',
    body: 'Every change is a NEP-297 event. Prove any of them final with a light client proof checked in your browser: validator signatures and merkle paths, no indexer trust.',
    href: '/sandbox/app/verify-proof',
  },
];

const USE_CASES = [
  { title: 'Reputation-gated communities', body: 'DAO membership, contributor levels and role credentials that gate access and budgets.' },
  { title: 'Private eligibility', body: 'Over 18, income above a threshold, employed: proven while the document is readable only inside the model TEE.' },
  { title: 'Contributor credentials', body: 'Merged pull requests counted by the checker from GitHub itself, so the claim cannot be faked.' },
  { title: 'Agent marketplaces', body: 'Hire agents by their verified owner, model and reviews; pay them per verification.' },
  { title: 'Cross-chain receipts', body: 'A payment on Base or Arbitrum becomes a NEAR attestation any contract can read.' },
  { title: 'Organizational issuers', body: 'Companies verified by governance, staking for a tier, issuing through employees, bots and 2-of-3 multisigs.' },
];

const TRACKS = [
  { title: 'Social Money', body: 'Reputation-based access and programmable rewards: token-gated and token-reward resolvers, governance-verified authorities, membership credentials.' },
  { title: 'Privacy and Private AI', body: 'Facts checked by a NEAR AI Cloud verifiable model in a TEE with end-to-end encryption; only hashes are stored.' },
  { title: 'Agent Economy', body: 'Identity, scoped delegation and reputation for agents, and verification sold per call over x402.' },
  { title: 'Open Innovation', body: 'Attestations about wallets on any chain, verified by Chain Signatures without an oracle, and light client proofs in the browser.' },
];

const DX = [
  { text: 'Credentials from a wallet, a passkey, the NEAR CLI keychain or env' },
  { text: 'One switch between testnet and mainnet across contracts, SDK, CLI and services' },
  { text: 'Storage paid as you go or from a NEP-145 balance someone else funded' },
  { text: 'UIDs computed off chain byte for byte like the contracts' },
];

const SDK = `import { AttestraClient, SchemaEncoder } from '@attestra/sdk';

const client = new AttestraClient({ network: 'testnet', accountId, privateKey });

const def = 'string name, u8 level, bool verified';
const { data } = await client.registerSchema({ definition: def, revocable: true });

const encoder = new SchemaEncoder(def);
const att = await client.createAttestation({
  schemaUid: data.schemaUid,
  subject: 'bob.testnet',
  data: encoder.encode({ name: 'Bob', level: 3, verified: true }),
});

// Prove the event is final, checked locally
const proof = await client.proveAttestation(att.data.attestationUid);
console.log(proof.data.verified); // true`;

const CLI = `# every command takes --json
attestra schema create -d "string name, u8 level" --revocable -a alice.testnet
attestra attestation create -s <schema uid> --subject bob.testnet \\
  --values '{"name":"Bob","level":3}' -a alice.testnet
attestra events prove <attestation uid>
attestra check run age_over_18 --subject bob.testnet --evidence @passport.txt
attestra agent profile research-agent.testnet`;

const MCP = `// Claude Code, Codex or Claude Desktop
{
  "mcpServers": {
    "attestra": {
      "command": "npx",
      "args": ["-y", "@attestra/mcp"],
      "env": { "NEAR_NETWORK": "testnet" }
    }
  }
}
// tools: verify_attestation, prove_attestation, get_agent_reputation,
// create_attestation, attest_foreign_instruction, paid_verify, ...`;

const SECTION = 'mx-auto max-w-7xl px-4 sm:px-6';

export default function Home() {
  return (
    <>
      {/* Hero */}
      <section className="border-b border-line">
        <div className={`${SECTION} grid items-center gap-x-16 gap-y-12 pb-16 pt-14 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,500px)] lg:pb-20 lg:pt-24`}>
          <div>
            <Eyebrow>The trust layer for NEAR</Eyebrow>
            <h1 className="mt-4 text-[2.25rem] font-semibold leading-[1.06] tracking-[-0.03em] text-fg sm:text-[3.5rem] lg:text-[3.75rem]">
              Facts you can verify.
              <br />
              <span className="text-mute">About anyone, any wallet, any agent.</span>
            </h1>
            <p className="mt-6 max-w-xl text-[16.5px] leading-relaxed text-soft">
              Attestra turns claims into on-chain attestations with a schema, an issuer and a proof. Check private facts with verifiable AI without revealing them, attest events on other chains without an oracle, and give AI agents an identity and a reputation.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="/sandbox/app" size="lg">
                Try it in the sandbox <ArrowRight className="size-4" />
              </ButtonLink>
              <ButtonLink href="/attestations" size="lg" variant="secondary">
                Explore attestations
              </ButtonLink>
              <Link href="/docs" className="px-2 text-[14px] font-medium text-soft underline-offset-4 hover:text-fg hover:underline">
                Read the docs
              </Link>
            </div>
            <div className="mt-12 grid max-w-md grid-cols-3 divide-x divide-[var(--line)] border-t border-line pt-5">
              {[
                ['7', 'Rust contracts'],
                [String(TOOLS.length), 'sandbox tools'],
                ['0', 'oracles to trust'],
              ].map(([n, l]) => (
                <div key={l} className="px-3 first:pl-0 sm:px-5">
                  <p className="font-display text-[1.6rem] font-semibold leading-none tabular-nums text-fg">{n}</p>
                  <p className="mt-1.5 text-[13px] leading-snug text-mute">{l}</p>
                </div>
              ))}
            </div>
          </div>
          <HeroVisual />
        </div>
      </section>

      {/* Network numbers and the primitives behind them */}
      <section className={`${SECTION} pt-10`} aria-label="Protocol">
        <LiveStats />
        <div className="mt-10 flex flex-col gap-3 border-t border-line pt-6 md:flex-row md:items-baseline md:gap-8">
          <p className="shrink-0 text-[13px] font-medium text-fg">Built on NEAR primitives</p>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-soft" aria-label="NEAR primitives used">
            {PRIMITIVES.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* How it works */}
      <section className={`${SECTION} py-24`}>
        <SectionHeading eyebrow="How it works" title="From a claim to a fact anyone can check." intro="Four steps, each a contract call you can make from the SDK, the CLI, the MCP server or the sandbox." />
        <ol className="mt-12 grid gap-px overflow-hidden rounded-xl border border-line bg-[var(--line)] md:grid-cols-2 xl:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col bg-panel p-6">
              <span className="font-mono text-[12px] text-mute">Step {i + 1}</span>
              <h3 className="mt-3 text-[16.5px] font-semibold text-fg">{s.title}</h3>
              <p className="mt-2 flex-1 text-[14px] leading-relaxed text-soft">{s.body}</p>
              <code className="mt-5 block truncate border-t border-line pt-3 font-mono text-[12px] text-fg">{s.code}</code>
            </li>
          ))}
        </ol>
      </section>

      {/* Only on NEAR */}
      <section className="border-y border-line bg-soft py-24">
        <div className={SECTION}>
          <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
            <SectionHeading
              eyebrow="Only on NEAR"
              title="What a registry on another chain cannot do."
              intro="Each feature uses a NEAR primitive as its core, not as an add-on: verifiable private inference, MPC signatures that read other chains, NEP-413 and NEP-366 for gasless flows, and light client proofs."
            />
            <Link href="/near" className="inline-flex shrink-0 items-center gap-1.5 text-[14px] font-medium text-fg underline-offset-4 hover:underline">
              How each one works <ArrowRight className="size-3.5" />
            </Link>
          </div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-line bg-[var(--line)] md:grid-cols-2 lg:grid-cols-3">
            {NEAR_FEATURES.map((f) => (
              <Link key={f.title} href={f.href} className="group flex flex-col bg-panel p-6 transition-colors hover:bg-panel-2">
                <span className="font-mono text-[11.5px] text-mute">{f.primitive}</span>
                <h3 className="mt-3 text-[16.5px] font-semibold leading-snug text-fg">{f.title}</h3>
                <p className="mt-2 flex-1 text-[14px] leading-relaxed text-soft">{f.body}</p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent">
                  Try it <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Developer experience */}
      <section className={`${SECTION} grid grid-cols-1 items-start gap-12 py-24 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16`}>
        <div>
          <SectionHeading eyebrow="Build with it" title="One SDK, one CLI, one MCP server." intro={<>Every method returns a ServiceResponse and never throws. Every CLI command takes <span className="whitespace-nowrap">--json</span>. Every read is a tool an agent can call.</>} />
          <ul className="mt-8 border-t border-line">
            {DX.map((d) => (
              <li key={d.text} className="border-b border-line py-3 text-[14px] text-soft">
                {d.text}
              </li>
            ))}
          </ul>
        </div>
        <CodeTabs
          className="min-w-0"
          tabs={[
            { label: 'SDK', title: 'attest.ts', code: SDK },
            { label: 'CLI', title: 'terminal', code: CLI },
            { label: 'MCP', title: 'mcp.json', code: MCP },
          ]}
        />
      </section>

      {/* Use cases */}
      <section className="border-t border-line py-24">
        <div className={SECTION}>
          <SectionHeading eyebrow="Use cases" title="Trust that other apps can read." />
          <div className="mt-12 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {USE_CASES.map((u) => (
              <div key={u.title} className="border-t border-line pt-5">
                <h3 className="text-[15.5px] font-semibold text-fg">{u.title}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-soft">{u.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Tracks */}
      <section className="border-t border-line bg-soft py-24">
        <div className={SECTION}>
          <SectionHeading eyebrow="Where it fits" title="Built for four NEAR Hackathon tracks." />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TRACKS.map((t) => (
              <div key={t.title} className="rounded-xl border border-line bg-panel p-5 shadow-panel">
                <h3 className="text-[15.5px] font-semibold text-fg">{t.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-soft">{t.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Call to action */}
      <section className={`${SECTION} pt-24`}>
        <div className="flex flex-col gap-8 rounded-xl border border-line bg-panel px-5 py-8 shadow-panel sm:px-10 sm:py-10 md:flex-row md:items-center md:justify-between">
          <div className="max-w-xl">
            <h2 className="text-balance text-[1.75rem] font-semibold leading-tight tracking-tight text-fg sm:text-[2rem]">Issue your first attestation in two minutes.</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-soft">Sign in with a NEAR wallet or a passkey, register a schema, attest, and prove it final, all on testnet.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-3">
            <ButtonLink href="/sandbox/app" size="lg">
              Open the sandbox <ArrowRight className="size-4" />
            </ButtonLink>
            <ButtonLink href="/docs" size="lg" variant="secondary">
              Read the docs
            </ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}

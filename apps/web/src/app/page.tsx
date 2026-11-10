import {
  ArrowRight,
  BadgeCheck,
  Bot,
  Building2,
  Coins,
  FileCheck2,
  Fingerprint,
  GitPullRequest,
  Globe2,
  KeyRound,
  Layers,
  Link2,
  Lock,
  Network,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { HeroVisual } from '@/components/marketing/HeroVisual';
import { LiveStats } from '@/components/marketing/LiveStats';
import { CodeTabs } from '@/components/ui/Code';
import { Reveal } from '@/components/ui/Reveal';
import { ButtonLink, Eyebrow, SectionHeading } from '@/components/ui/primitives';

const PRIMITIVES = ['NEAR AI Cloud', 'OutLayer TEE', 'Chain Signatures', 'NEP-413 signatures', 'NEP-366 meta transactions', 'NEP-171 credentials', 'NEP-145 storage', 'NEP-297 events', 'Light client proofs', 'x402 payments', 'Passkeys', 'NEAR Connect'];

const STEPS = [
  { icon: Layers, title: 'Define a schema', body: 'Name the fields of a claim once. Its UID is derived from the definition, so anyone can compute it.', code: 'string name, u8 level' },
  { icon: FileCheck2, title: 'Attest', body: 'An authority issues a claim about a NEAR account or a wallet on any chain. Delegates, agents and multisigs can issue too.', code: 'attest(schema, subject, data)' },
  { icon: Workflow, title: 'Resolve', body: 'Resolvers add rules: whitelists, fees, token gates, rewards, or a pipeline of all of them. A refusal rolls everything back.', code: 'pending → created | rejected' },
  { icon: ShieldCheck, title: 'Verify anywhere', body: 'Read it from the contract, decode it with the SDK, or prove its event is final with a light client proof in the browser.', code: 'isValid(uid) → true' },
];

const NEAR_FEATURES = [
  {
    icon: Sparkles,
    tone: 'from-violet-500/15 text-violet-600 dark:text-violet-400',
    title: 'Private facts, checked by verifiable AI',
    body: 'Evidence is encrypted to a NEAR AI Cloud model inside a TEE. A checker (an OutLayer TEE component, or the agent with a bootstrap key in local mode) checks it against the rule and signs a verdict; only its hash goes on chain.',
    href: '/sandbox/app/private-check',
    span: 'lg:col-span-2',
  },
  {
    icon: Link2,
    tone: 'from-sky-500/15 text-sky-600 dark:text-sky-400',
    title: 'Facts about any chain, without an oracle',
    body: 'The NEAR MPC network verifies a transaction on Base, Arbitrum or Polygon and the contract checks its signature itself.',
    href: '/sandbox/app/cross-chain',
    span: '',
  },
  {
    icon: Bot,
    tone: 'from-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    title: 'Know Your Agent',
    body: 'Agents get an owner-signed identity, scoped delegation with limits and expiry, and reviews from the people and agents who hired them.',
    href: '/agents',
    span: '',
  },
  {
    icon: Coins,
    tone: 'from-amber-500/15 text-amber-600 dark:text-amber-400',
    title: 'Verification as a paid service',
    body: 'Agents buy "verify a claim" and "check an agent" per call over x402 on NEAR, paying with a signed token transfer and no NEAR for gas.',
    href: '/sandbox/app/paid-verify',
    span: '',
  },
  {
    icon: Fingerprint,
    tone: 'from-rose-500/15 text-rose-600 dark:text-rose-400',
    title: 'Gasless issuing, passkey subjects',
    body: 'Issuers sign requests and the relayer pays. Subjects with no wallet claim and view credentials with a passkey.',
    href: '/sandbox/app/gasless',
    span: '',
  },
  {
    icon: ScrollText,
    tone: 'from-brand-500/15 text-brand-600 dark:text-brand-400',
    title: 'A trustless audit trail',
    body: 'Every change is a NEP-297 event. Prove any of them final with a light client proof checked in your browser: validator signatures and merkle paths, no indexer trust.',
    href: '/sandbox/app/verify-proof',
    span: 'lg:col-span-2',
  },
];

const USE_CASES = [
  { icon: Users, title: 'Reputation-gated communities', body: 'DAO membership, contributor levels and role credentials that gate access and budgets.' },
  { icon: Lock, title: 'Private eligibility', body: 'Over 18, income above a threshold, employed: proven while the document is readable only inside the model TEE.' },
  { icon: GitPullRequest, title: 'Contributor credentials', body: 'Merged pull requests counted by the checker from GitHub itself, so the claim cannot be faked.' },
  { icon: Bot, title: 'Agent marketplaces', body: 'Hire agents by their verified owner, model and reviews; pay them per verification.' },
  { icon: Globe2, title: 'Cross-chain receipts', body: 'A payment on Base or Arbitrum becomes a NEAR attestation any contract can read.' },
  { icon: Building2, title: 'Organizational issuers', body: 'Companies verified by governance, staking for a tier, issuing through employees, bots and 2-of-3 multisigs.' },
];

const TRACKS = [
  { title: 'Social Money', body: 'Reputation-based access and programmable rewards: token-gated and token-reward resolvers, governance-verified authorities, membership credentials.' },
  { title: 'Privacy and Private AI', body: 'Facts checked by a NEAR AI Cloud verifiable model in a TEE with end-to-end encryption; only hashes are stored.' },
  { title: 'Agent Economy', body: 'Identity, scoped delegation and reputation for agents, and verification sold per call over x402.' },
  { title: 'Open Innovation', body: 'Attestations about wallets on any chain, verified by Chain Signatures without an oracle, and light client proofs in the browser.' },
];

const DX = [
  { icon: KeyRound, text: 'Credentials from a wallet, a passkey, the NEAR CLI keychain or env' },
  { icon: Network, text: 'One switch between testnet and mainnet across contracts, SDK, CLI and services' },
  { icon: Wallet, text: 'Storage paid as you go or from a NEP-145 balance someone else funded' },
  { icon: BadgeCheck, text: 'UIDs computed off chain byte for byte like the contracts' },
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

export default function Home() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="spotlight pointer-events-none absolute inset-0" />
        <div className="grid-fade pointer-events-none absolute inset-0" />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 pb-16 pt-14 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pb-24 lg:pt-20">
          <div>
            <div className="animate-fade-up">
              <Eyebrow>The trust layer for NEAR</Eyebrow>
            </div>
            <h1 className="mt-6 animate-fade-up text-[2.6rem] font-semibold leading-[1.02] tracking-tight text-fg [animation-delay:80ms] sm:text-6xl lg:text-[4.1rem]">
              Facts you can verify.
              <br />
              <span className="text-gradient">About anyone, any wallet, any agent.</span>
            </h1>
            <p className="mt-6 max-w-xl animate-fade-up text-[16.5px] leading-relaxed text-soft [animation-delay:160ms]">
              Attestra turns claims into on-chain attestations with a schema, an issuer and a proof. Check private facts with verifiable AI without revealing them, attest events on other chains without an oracle, and give AI agents an identity and a reputation.
            </p>
            <div className="mt-8 flex animate-fade-up flex-wrap items-center gap-3 [animation-delay:240ms]">
              <ButtonLink href="/sandbox/app" size="lg">
                Try it in the sandbox <ArrowRight className="size-4" />
              </ButtonLink>
              <ButtonLink href="/attestations" size="lg" variant="secondary">
                Explore attestations
              </ButtonLink>
              <Link href="/docs" className="px-2 text-[14px] font-medium text-soft underline-offset-4 hover:text-accent hover:underline">
                Read the docs
              </Link>
            </div>
            <div className="mt-10 grid max-w-xl animate-fade-up grid-cols-3 gap-4 [animation-delay:320ms]">
              {[
                ['8', 'Rust contracts'],
                ['31', 'sandbox tools'],
                ['0', 'oracles to trust'],
              ].map(([n, l]) => (
                <div key={l} className="border-l-2 border-brand-500/60 pl-3">
                  <p className="font-display text-2xl font-semibold text-fg">{n}</p>
                  <p className="text-[12.5px] text-mute">{l}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="animate-fade-up [animation-delay:200ms]">
            <HeroVisual />
          </div>
        </div>
        <div className="relative mx-auto max-w-7xl px-4 pb-16 sm:px-6">
          <LiveStats />
        </div>
      </section>

      {/* ── Primitives marquee ───────────────────────────────────────────── */}
      <section className="border-y border-line bg-soft py-5" aria-label="NEAR primitives used">
        <div className="relative overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
          <div className="flex w-max animate-marquee gap-3 hover:[animation-play-state:paused]">
            {[...PRIMITIVES, ...PRIMITIVES].map((p, i) => (
              <span key={i} className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-soft shadow-panel">
                <span className="size-1.5 rounded-full bg-gradient-to-br from-brand-400 to-brand-600" />
                {p}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 py-24 sm:px-6">
        <Reveal>
          <SectionHeading eyebrow="How it works" title={<>From a claim to a fact anyone can check.</>} intro="Four steps, each a contract call you can make from the SDK, the CLI, the MCP server or the sandbox." />
        </Reveal>
        <div className="relative mt-14 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          <div className="beam pointer-events-none absolute left-[8%] right-[8%] top-[42px] hidden h-px opacity-70 xl:block" />
          {STEPS.map((s, i) => (
            <Reveal key={s.title} delay={i * 90}>
              <div className="group relative h-full rounded-2xl border border-line bg-panel p-5 shadow-panel transition duration-300 hover:-translate-y-1 hover:border-brand-400/50 hover:shadow-float">
                <div className="flex items-center justify-between">
                  <span className="relative grid size-11 place-items-center rounded-xl bg-gradient-to-b from-brand-400 to-brand-600 text-white shadow-[0_10px_24px_-10px_rgba(234,88,12,0.8)]">
                    <s.icon className="size-5" />
                  </span>
                  <span className="font-mono text-[12px] font-medium text-mute">0{i + 1}</span>
                </div>
                <h3 className="mt-5 text-[17px] font-semibold text-fg">{s.title}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-soft">{s.body}</p>
                <code className="mt-4 block truncate rounded-lg border border-line bg-soft px-2.5 py-1.5 font-mono text-[11.5px] text-accent">{s.code}</code>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Only on NEAR ─────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-y border-line bg-soft py-24">
        <div className="pointer-events-none absolute -right-40 top-10 size-[38rem] rounded-full bg-[radial-gradient(circle,var(--glow),transparent_65%)] blur-3xl" />
        <div className="relative mx-auto max-w-7xl px-4 sm:px-6">
          <Reveal>
            <SectionHeading
              eyebrow="Only on NEAR"
              title={<>What a registry on another chain cannot do.</>}
              intro="Each feature uses a NEAR primitive as its core, not as an add-on: verifiable private inference, MPC signatures that read other chains, NEP-413 and NEP-366 for gasless flows, and light client proofs."
            />
          </Reveal>
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {NEAR_FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={i * 70} className={f.span}>
                <Link href={f.href} className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-panel p-6 shadow-panel transition duration-300 hover:-translate-y-1 hover:border-brand-400/50 hover:shadow-float">
                  <div className={`pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b ${f.tone.split(' ')[0]} to-transparent opacity-70`} />
                  <span className={`relative grid size-10 place-items-center rounded-xl border border-line bg-panel ${f.tone.split(' ').slice(1).join(' ')}`}>
                    <f.icon className="size-5" />
                  </span>
                  <h3 className="relative mt-5 text-[17px] font-semibold leading-snug text-fg">{f.title}</h3>
                  <p className="relative mt-2 flex-1 text-[13.5px] leading-relaxed text-soft">{f.body}</p>
                  <span className="relative mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent">
                    Try it <ArrowRight className="size-3.5 transition group-hover:translate-x-1" />
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Developer experience ─────────────────────────────────────────── */}
      <section className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-4 py-24 sm:px-6 lg:grid-cols-[0.9fr_1.1fr]">
        <Reveal>
          <SectionHeading eyebrow="Build with it" title="One SDK, one CLI, one MCP server." intro={<>Every method returns a ServiceResponse and never throws. Every CLI command takes <span className="whitespace-nowrap">--json</span>. Every read is a tool an agent can call.</>} />
          <ul className="mt-8 space-y-3">
            {DX.map((d) => (
              <li key={d.text} className="flex items-start gap-3 text-[14px] text-soft">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
                  <d.icon className="size-3.5" />
                </span>
                {d.text}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={120}>
          <CodeTabs
            tabs={[
              { label: 'SDK', title: 'attest.ts', code: SDK },
              { label: 'CLI', title: 'terminal', code: CLI },
              { label: 'MCP', title: 'mcp.json', code: MCP },
            ]}
          />
        </Reveal>
      </section>

      {/* ── Use cases ────────────────────────────────────────────────────── */}
      <section className="border-t border-line bg-soft py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <Reveal>
            <SectionHeading eyebrow="Use cases" title="Trust that other apps can read." center />
          </Reveal>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-[var(--line)] shadow-panel sm:grid-cols-2 lg:grid-cols-3">
            {USE_CASES.map((u, i) => (
              <Reveal key={u.title} delay={i * 60} className="bg-panel">
                <div className="group h-full p-6 transition hover:bg-panel-2">
                  <u.icon className="size-5 text-accent transition group-hover:scale-110" />
                  <h3 className="mt-4 text-[16px] font-semibold text-fg">{u.title}</h3>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-soft">{u.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Tracks ───────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 py-24 sm:px-6">
        <Reveal>
          <SectionHeading eyebrow="Where it fits" title="Built for four NEAR Hackathon tracks." />
        </Reveal>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TRACKS.map((t, i) => (
            <Reveal key={t.title} delay={i * 70}>
              <div className="ring-gradient h-full rounded-2xl bg-panel p-5 shadow-panel">
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent">Track</p>
                <h3 className="mt-2 text-[17px] font-semibold text-fg">{t.title}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-soft">{t.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#120d09] px-6 py-14 text-center shadow-float sm:px-12">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50rem_20rem_at_50%_-4rem,rgba(249,115,22,0.45),transparent_70%)]" />
            <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(to_right,rgba(255,237,213,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,237,213,0.06)_1px,transparent_1px)] [background-size:48px_48px]" />
            <div className="relative">
              <h2 className="text-3xl font-semibold text-white sm:text-[2.6rem]">Issue your first attestation in two minutes.</h2>
              <p className="mx-auto mt-4 max-w-xl text-[15.5px] text-stone-300">Sign in with a NEAR wallet or a passkey, register a schema, attest, and prove it final, all on testnet.</p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <ButtonLink href="/sandbox/app" size="lg">
                  Open the sandbox <ArrowRight className="size-4" />
                </ButtonLink>
                <ButtonLink href="/docs" size="lg" variant="secondary" className="!border-white/15 !bg-white/5 !text-white hover:!bg-white/10">
                  Read the docs
                </ButtonLink>
              </div>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}

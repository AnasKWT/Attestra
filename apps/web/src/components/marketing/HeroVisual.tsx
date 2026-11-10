import { BadgeCheck, Bot, Fingerprint, Link2, ShieldCheck, Sparkles } from 'lucide-react';
import { LogoMark } from '../brand/Logo';

/**
 * The hero's floating stack of attestation cards around a glowing seal. Pure CSS motion.
 * The orbit layout needs about 560px; on phones the cards stack in a staggered column instead.
 */
export function HeroVisual() {
  return (
    <div className="relative mx-auto flex w-full max-w-[560px] select-none flex-col gap-3 py-2 sm:block sm:aspect-[1.05] sm:py-0" aria-hidden="true">
      {/* light */}
      <div className="absolute inset-[12%] -translate-x-[8%] animate-pulse-glow rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.38),transparent_65%)] blur-2xl" />
      {/* orbit rings */}
      <div className="absolute inset-[8%] -translate-x-[8%] rounded-full border border-dashed border-brand-500/25 max-sm:hidden" />
      <div className="absolute inset-[24%] -translate-x-[8%] animate-spin-slow max-sm:hidden rounded-full border border-brand-500/20 [border-top-color:rgba(249,115,22,0.7)]" />

      {/* center seal */}
      <div className="absolute left-[42%] top-[50%] -translate-x-1/2 -translate-y-1/2 max-sm:hidden">
        <div className="relative grid size-28 place-items-center rounded-[28px] border border-white/40 bg-gradient-to-b from-white/90 to-white/60 shadow-[0_30px_80px_-20px_rgba(234,88,12,0.6)] backdrop-blur dark:border-white/10 dark:from-white/10 dark:to-white/[0.03]">
          <LogoMark size={64} />
          <span className="absolute -bottom-3 rounded-full border border-line bg-panel px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-widest text-accent shadow-panel">final</span>
        </div>
      </div>

      {/* card: private AI check */}
      <Card className="mr-10 sm:left-0 sm:top-[3%] sm:mr-0 sm:w-[54%] animate-float" delay="0s">
        <Head icon={<Sparkles className="size-3.5" />} label="Private AI check" tone="text-violet-500" />
        <p className="mt-2 text-[13px] font-medium text-fg">is at least 18 years old</p>
        <div className="mt-2.5 flex items-center justify-between">
          <Chip>enclave signed</Chip>
          <span className="font-mono text-[10.5px] text-mute">evidence: sha256 only</span>
        </div>
      </Card>

      {/* card: cross-chain */}
      <Card className="ml-10 sm:right-0 sm:top-[38%] sm:ml-0 sm:w-[45%] animate-float" delay="1.4s">
        <Head icon={<Link2 className="size-3.5" />} label="Fact on another chain" tone="text-sky-500" />
        <p className="mt-2 text-[13px] font-medium text-fg">paid 120 USDC on Base</p>
        <div className="mt-2.5 flex items-center justify-between">
          <Chip>MPC verified</Chip>
          <span className="font-mono text-[10.5px] text-mute">no oracle</span>
        </div>
      </Card>

      {/* card: agent */}
      <Card className="mr-5 sm:bottom-[3%] sm:left-[2%] sm:mr-0 sm:w-[56%] animate-float" delay="2.6s">
        <Head icon={<Bot className="size-3.5" />} label="Know Your Agent" tone="text-emerald-500" />
        <div className="mt-2 flex items-center justify-between">
          <p className="text-[13px] font-medium text-fg">research-agent.near</p>
          <span className="text-[12px] tracking-wider text-amber-500">★★★★★</span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Chip>owner verified</Chip>
          <Chip>scoped delegation</Chip>
        </div>
      </Card>

      {/* small floating badges */}
      <Pill className="right-[6%] top-[4%]" icon={<ShieldCheck className="size-3.5 text-emerald-500" />}>
        light client proof
      </Pill>
      <Pill className="bottom-[12%] right-[2%]" icon={<Fingerprint className="size-3.5 text-accent" />}>
        passkey subject
      </Pill>
      <Pill className="left-[0%] top-[34%]" icon={<BadgeCheck className="size-3.5 text-sky-500" />}>
        NEP-171 credential
      </Pill>
    </div>
  );
}

function Card({ children, className, delay }: { children: React.ReactNode; className: string; delay: string }) {
  return (
    <div style={{ animationDelay: delay }} className={`ring-gradient glass relative rounded-2xl sm:absolute border border-line p-3.5 shadow-float ${className}`}>
      {children}
    </div>
  );
}

function Head({ icon, label, tone }: { icon: React.ReactNode; label: string; tone: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={tone}>{icon}</span>
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-mute">{label}</span>
      <span className="ml-auto size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.2)]" />
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md border border-line bg-soft px-1.5 py-0.5 text-[10.5px] font-medium text-soft">{children}</span>;
}

function Pill({ children, icon, className }: { children: React.ReactNode; icon: React.ReactNode; className: string }) {
  return (
    <span className={`glass absolute inline-flex max-sm:hidden items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-fg shadow-panel ${className}`}>
      {icon}
      {children}
    </span>
  );
}

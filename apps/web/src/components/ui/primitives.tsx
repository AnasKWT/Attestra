import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-brand-400 to-brand-600 text-white shadow-[0_1px_0_rgba(255,255,255,0.35)_inset,0_8px_20px_-8px_rgba(234,88,12,0.7)] hover:from-brand-400 hover:to-brand-500 active:translate-y-px',
  secondary: 'border border-line-strong bg-panel text-fg shadow-panel hover:border-brand-400/60 hover:text-accent',
  ghost: 'text-soft hover:bg-soft hover:text-fg',
  danger: 'border border-red-500/30 bg-red-500/10 text-red-600 hover:bg-red-500/15 dark:text-red-400',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-[15px] gap-2',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra = '') {
  return `inline-flex items-center justify-center rounded-lg font-medium transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${extra}`;
}

export function Button({ variant = 'primary', size = 'md', className = '', ...p }: ComponentProps<'button'> & { variant?: Variant; size?: Size }) {
  return <button {...p} className={buttonClass(variant, size, className)} />;
}

export function ButtonLink({ href, variant = 'primary', size = 'md', className = '', children, external }: { href: string; variant?: Variant; size?: Size; className?: string; children: ReactNode; external?: boolean }) {
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={buttonClass(variant, size, className)}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}

export function Panel({ className = '', children, glow = false }: { className?: string; children: ReactNode; glow?: boolean }) {
  return <div className={`rounded-2xl border border-line bg-panel shadow-panel ${glow ? 'ring-gradient' : ''} ${className}`}>{children}</div>;
}

export function PanelHeader({ title, subtitle, right, icon }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">{icon}</span>}
        <div className="min-w-0">
          <h3 className="font-display text-[15px] font-semibold text-fg">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[13px] text-mute">{subtitle}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

const TONES = {
  neutral: 'border-line bg-soft text-soft',
  brand: 'border-brand-500/25 bg-accent-soft text-accent',
  ok: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warn: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  bad: 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400',
  info: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-400',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'neutral', children, className = '', dot = false }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium ${TONES[tone]} ${className}`}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = { active: 'ok', pending: 'warn', revoking: 'warn', revoked: 'bad', expired: 'neutral', created: 'ok', rejected: 'bad', refused: 'bad', scheduled: 'info' };

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} dot>
      {status}
    </Badge>
  );
}

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`bracket text-accent ${className}`}>{children}</span>;
}

export function SectionHeading({ eyebrow, title, intro, center = false }: { eyebrow?: ReactNode; title: ReactNode; intro?: ReactNode; center?: boolean }) {
  return (
    <div className={center ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="mt-4 text-3xl font-semibold leading-[1.1] text-fg sm:text-[2.6rem]">{title}</h2>
      {intro && <p className="mt-4 text-[15.5px] leading-relaxed text-soft">{intro}</p>}
    </div>
  );
}

export function KeyValue({ label, children, mono = false }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-line py-3 last:border-0 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-[12.5px] font-medium uppercase tracking-wide text-mute">{label}</dt>
      <dd className={`min-w-0 break-words text-[14px] text-fg ${mono ? 'font-mono text-[13px]' : ''}`}>{children}</dd>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} />;
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 grid size-11 place-items-center rounded-xl border border-line bg-soft text-mute">{icon}</div>}
      <p className="font-display text-[15px] font-semibold text-fg">{title}</p>
      {children && <div className="mt-1.5 max-w-sm text-[13.5px] text-mute">{children}</div>}
    </div>
  );
}

export function Alert({ tone = 'info', title, children }: { tone?: Tone; title?: ReactNode; children: ReactNode }) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-[13.5px] ${TONES[tone]}`}>
      {title && <p className="mb-0.5 font-semibold">{title}</p>}
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}

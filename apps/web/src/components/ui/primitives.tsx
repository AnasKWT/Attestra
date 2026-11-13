import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'btn-shine bg-brand-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_1px_2px_rgba(28,25,23,0.12)] hover:bg-brand-700',
  secondary: 'border border-line-strong bg-panel text-fg shadow-panel hover:bg-panel-2 hover:border-ink-400/50',
  ghost: 'text-soft hover:bg-soft hover:text-fg',
  danger: 'border border-red-500/30 bg-red-500/10 text-red-600 hover:bg-red-500/15 dark:text-red-400',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-[14.5px] gap-2',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra = '') {
  return `inline-flex items-center justify-center rounded-lg font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${extra}`;
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

/** `label` names the panel as a region, for screen readers and for tests that find it by role. */
export function Panel({ className = '', children, label }: { className?: string; children: ReactNode; label?: string }) {
  return (
    <div role={label ? 'region' : undefined} aria-label={label} className={`rounded-xl border border-line bg-panel shadow-panel ${className}`}>
      {children}
    </div>
  );
}

export function PanelHeader({ title, subtitle, right }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h3 className="font-display text-[15px] font-semibold text-fg">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] text-mute">{subtitle}</p>}
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

export function Badge({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-px text-[11.5px] font-medium leading-[18px] ${TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = { active: 'ok', pending: 'warn', revoking: 'warn', revoked: 'bad', expired: 'neutral', created: 'ok', rejected: 'bad', refused: 'bad', scheduled: 'info' };

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
      {status}
    </Badge>
  );
}

/** A short label above a heading: sentence case, the accent colour, nothing around it. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-[13.5px] font-medium text-accent ${className}`}>{children}</p>;
}

export function SectionHeading({ eyebrow, title, intro, center = false }: { eyebrow?: ReactNode; title: ReactNode; intro?: ReactNode; center?: boolean }) {
  return (
    <div className={center ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className={`${eyebrow ? 'mt-3' : ''} text-balance text-[1.75rem] font-semibold leading-[1.15] tracking-tight text-fg sm:text-[2.25rem]`}>{title}</h2>
      {intro && <p className="mt-4 text-[15.5px] leading-relaxed text-soft">{intro}</p>}
    </div>
  );
}

export function KeyValue({ label, children, mono = false }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-line py-3 last:border-0 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-[13px] text-mute">{label}</dt>
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
      {icon && <div className="mb-3 grid size-10 place-items-center rounded-lg border border-line bg-soft text-mute">{icon}</div>}
      <p className="font-display text-[15px] font-semibold text-fg">{title}</p>
      {children && <div className="mt-1.5 max-w-sm text-[13.5px] text-mute">{children}</div>}
    </div>
  );
}

export function Alert({ tone = 'info', title, children }: { tone?: Tone; title?: ReactNode; children: ReactNode }) {
  return (
    <div className={`rounded-lg border px-4 py-3 text-[13.5px] ${TONES[tone]}`}>
      {title && <p className="mb-0.5 font-semibold">{title}</p>}
      <div className="leading-relaxed [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

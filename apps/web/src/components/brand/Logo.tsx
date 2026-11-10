import { MARK, MARK_COLORS } from './mark';

/** The Attestra mark: an open hexagon in the text colour and a check leaving through it. */
export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox={MARK.viewBox} className={`text-fg ${className}`} aria-hidden="true">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d={MARK.hex} stroke="currentColor" strokeWidth={MARK.hexWidth} />
        <path d={MARK.check} stroke={MARK_COLORS.check} strokeWidth={MARK.checkWidth} />
      </g>
    </svg>
  );
}

export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      <span className="font-display text-[19px] font-semibold tracking-tight text-fg">
        Attest<span className="text-accent">ra</span>
      </span>
    </span>
  );
}

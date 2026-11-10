import { useId } from 'react';
import { MARK, MARK_COLORS } from './mark';

/** The Attestra mark: a check in two strokes, accent and text colour, cut apart where they meet. */
export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  const cut = `cut${useId().replace(/:/g, '')}`;
  return (
    <svg width={size} height={size} viewBox={MARK.viewBox} className={`text-fg ${className}`} aria-hidden="true">
      <defs>
        <mask id={cut} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <path d={MARK.long} stroke="#000" strokeWidth={MARK.width + 2 * MARK.gap} strokeLinecap="round" />
        </mask>
      </defs>
      <g fill="none" strokeLinecap="round" strokeWidth={MARK.width}>
        <path d={MARK.short} stroke={MARK_COLORS.check} mask={`url(#${cut})`} />
        <path d={MARK.long} stroke="currentColor" />
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

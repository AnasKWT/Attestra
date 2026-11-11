import { useId } from 'react';
import { MARK, MARK_COLORS } from './mark';

/** The Attestra mark: a check in two strokes, accent and text colour, cut apart where they meet, leaving an open hexagon. */
export function LogoMark({ size = 28, className = '', animated = false }: { size?: number; className?: string; animated?: boolean }) {
  const cut = `cut${useId().replace(/:/g, '')}`;
  return (
    <svg width={size} height={size} viewBox={MARK.viewBox} className={`text-fg ${animated ? 'mark-draw' : ''} ${className}`} aria-hidden="true">
      <defs>
        <mask id={cut} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <path d={MARK.long} stroke="#000" strokeWidth={MARK.width + 2 * MARK.gap} strokeLinecap="round" />
        </mask>
      </defs>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d={MARK.hex} stroke="currentColor" strokeWidth={MARK.hexWidth} pathLength={1} data-part="hex" />
        <path d={MARK.short} stroke={MARK_COLORS.check} strokeWidth={MARK.width} mask={`url(#${cut})`} pathLength={1} data-part="short" />
        <path d={MARK.long} stroke="currentColor" strokeWidth={MARK.width} pathLength={1} data-part="long" />
      </g>
    </svg>
  );
}

export function Logo({ size = 28, className = '', animated = false }: { size?: number; className?: string; animated?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} animated={animated} />
      <span className="font-display text-[19px] font-semibold tracking-tight text-fg">
        Attest<span className="text-accent">ra</span>
      </span>
    </span>
  );
}

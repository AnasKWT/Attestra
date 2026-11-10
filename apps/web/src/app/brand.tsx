/** Shared markup for generated images (icons and share cards), rendered by next/og. */

import { MARK, MARK_COLORS } from '@/components/brand/mark';

/** The mark for a known ground (share cards, app icons): the cut is a halo in the ground colour. */
export function MarkSvg({ size, ink = MARK_COLORS.inkDark, ground = '#0f0b08' }: { size: number; ink?: string; ground?: string }) {
  return (
    <svg width={size} height={size} viewBox={MARK.viewBox}>
      <g fill="none" strokeLinecap="round">
        <path d={MARK.short} stroke={MARK_COLORS.check} strokeWidth={MARK.width} />
        <path d={MARK.long} stroke={ground} strokeWidth={MARK.width + 2 * MARK.gap} />
        <path d={MARK.long} stroke={ink} strokeWidth={MARK.width} />
      </g>
    </svg>
  );
}

export function ShareCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: '#0f0b08', backgroundImage: 'radial-gradient(900px 420px at 50% -80px, rgba(249,115,22,0.55), transparent 70%)', color: '#fff', fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <MarkSvg size={72} />
        <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>
          Attest<span style={{ color: '#fb923c' }}>ra</span>
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <span style={{ fontSize: 72, fontWeight: 700, lineHeight: 1.04, letterSpacing: -2, maxWidth: 980 }}>{title}</span>
        <span style={{ fontSize: 30, color: '#d6d3d1', maxWidth: 940, lineHeight: 1.35 }}>{subtitle}</span>
      </div>
      <div style={{ display: 'flex', gap: 14 }}>
        {['NEAR AI Cloud', 'Chain Signatures', 'Know Your Agent', 'Light client proofs'].map((t) => (
          <span key={t} style={{ fontSize: 22, padding: '8px 18px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.18)', color: '#fed7aa' }}>{t}</span>
        ))}
      </div>
    </div>
  );
}

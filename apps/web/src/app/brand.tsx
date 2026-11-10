/** Shared markup for generated images (icons and share cards), rendered by next/og. */

export function MarkSvg({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <defs>
        <linearGradient id="g" x1="10" y1="4" x2="54" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fdba74" />
          <stop offset="0.45" stopColor="#f97316" />
          <stop offset="1" stopColor="#c2410c" />
        </linearGradient>
      </defs>
      <path d="M32 3.5 56.5 17.6v28.8L32 60.5 7.5 46.4V17.6z" fill="url(#g)" stroke="url(#g)" strokeWidth="3" strokeLinejoin="round" />
      <path d="M32 11.5 49.5 21.6v20.8L32 52.5 14.5 42.4V21.6z" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M21.5 32.5 29 40l14-15" fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
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

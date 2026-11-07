import { useId } from 'react';

/** The Attestra mark: a sealed hexagon with a check, lit from the top. */
export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="10" y1="4" x2="54" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fdba74" />
          <stop offset="0.45" stopColor="#f97316" />
          <stop offset="1" stopColor="#c2410c" />
        </linearGradient>
        <linearGradient id={`h${id}`} x1="32" y1="4" x2="32" y2="34" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M32 3.5 56.5 17.6v28.8L32 60.5 7.5 46.4V17.6z" fill={`url(#g${id})`} stroke={`url(#g${id})`} strokeWidth="3" strokeLinejoin="round" />
      <path d="M32 3.5 56.5 17.6 32 31.7 7.5 17.6z" fill={`url(#h${id})`} opacity="0.55" />
      <path d="M32 11.5 49.5 21.6v20.8L32 52.5 14.5 42.4V21.6z" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M21.5 32.5 29 40l14-15" fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
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

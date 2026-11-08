import type { ReactNode } from 'react';
import { Eyebrow } from '../ui/primitives';

export function PageHero({ eyebrow, title, intro, children }: { eyebrow: string; title: ReactNode; intro: ReactNode; children?: ReactNode }) {
  return (
    <section className="relative overflow-hidden border-b border-line">
      <div className="spotlight pointer-events-none absolute inset-0" />
      <div className="grid-fade pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-5xl px-4 pb-16 pt-16 text-center sm:px-6 sm:pt-20">
        <div className="animate-fade-up"><Eyebrow>{eyebrow}</Eyebrow></div>
        <h1 className="mx-auto mt-6 max-w-3xl animate-fade-up text-4xl font-semibold leading-[1.05] text-fg [animation-delay:80ms] sm:text-[3.4rem]">{title}</h1>
        <p className="mx-auto mt-5 max-w-2xl animate-fade-up text-[16px] leading-relaxed text-soft [animation-delay:160ms]">{intro}</p>
        {children && <div className="mt-8 flex animate-fade-up flex-wrap justify-center gap-3 [animation-delay:240ms]">{children}</div>}
      </div>
    </section>
  );
}

export function FeatureRow({ icon, title, body }: { icon: ReactNode; title: string; body: ReactNode }) {
  return (
    <div className="flex gap-4 rounded-2xl border border-line bg-panel p-5 shadow-panel transition hover:border-brand-400/40">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">{icon}</span>
      <div>
        <h3 className="text-[16px] font-semibold text-fg">{title}</h3>
        <p className="mt-1 text-[13.5px] leading-relaxed text-soft">{body}</p>
      </div>
    </div>
  );
}

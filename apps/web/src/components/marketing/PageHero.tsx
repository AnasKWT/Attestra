import type { ReactNode } from 'react';
import { Eyebrow } from '../ui/primitives';

export function PageHero({ eyebrow, title, intro, children }: { eyebrow: string; title: ReactNode; intro: ReactNode; children?: ReactNode }) {
  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-4xl px-4 pb-16 pt-16 text-center sm:px-6 sm:pb-20 sm:pt-24">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mx-auto mt-4 max-w-3xl text-balance text-[2.25rem] font-semibold leading-[1.08] tracking-[-0.03em] text-fg sm:text-[3.25rem]">{title}</h1>
        <p className="mx-auto mt-5 max-w-2xl text-[16px] leading-relaxed text-soft">{intro}</p>
        {children && <div className="mt-8 flex flex-wrap justify-center gap-3">{children}</div>}
      </div>
    </section>
  );
}

/** A titled paragraph in a hairline card. */
export function FeatureRow({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-5">
      <h3 className="text-[15.5px] font-semibold text-fg">{title}</h3>
      <p className="mt-1.5 text-[14px] leading-relaxed text-soft">{body}</p>
    </div>
  );
}

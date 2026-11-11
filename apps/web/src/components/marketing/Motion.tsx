'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** True when the viewer asked for less motion; animations then show their resting state. */
function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Counts from 0 up to `value` once it is known, easing out; prints the final number without motion. */
export function CountUp({ value, format = (n) => n.toLocaleString('en-US'), ms = 1400 }: { value: number; format?: (n: number) => string; ms?: number }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const duration = reducedMotion() ? 0 : ms;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      setShown(Math.round(value * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return <>{format(shown)}</>;
}

/**
 * A grid whose 1px gaps light up around the pointer: sets --gx/--gy on the grid and --mx/--my on every
 * `.spot` child, so the borders and the card under the pointer glow.
 */
export function Spotlight({ className = '', children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    const grid = ref.current;
    if (!grid) return;
    const g = grid.getBoundingClientRect();
    grid.style.setProperty('--gx', `${e.clientX - g.left}px`);
    grid.style.setProperty('--gy', `${e.clientY - g.top}px`);
    for (const el of grid.querySelectorAll<HTMLElement>('.spot')) {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
  };
  const leave = () => {
    ref.current?.style.removeProperty('--gx');
    ref.current?.style.removeProperty('--gy');
  };
  return (
    <div ref={ref} onPointerMove={move} onPointerLeave={leave} className={`spot-grid ${className}`}>
      {children}
    </div>
  );
}

/** Which of `count` steps is lit, moving on every `ms` while the list is on screen. */
export function useCycle(count: number, ms: number) {
  const ref = useRef<HTMLOListElement>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (reducedMotion() || !ref.current) return;
    let timer = 0;
    const io = new IntersectionObserver(([e]) => {
      window.clearInterval(timer);
      if (e.isIntersecting) timer = window.setInterval(() => setActive((a) => (a + 1) % count), ms);
    });
    io.observe(ref.current);
    return () => {
      io.disconnect();
      window.clearInterval(timer);
    };
  }, [count, ms]);
  return { ref, active };
}

export interface Step {
  title: string;
  body: string;
  code: string;
}

const STEP_MS = 2800;

/** The four steps of the protocol, lit one after another with a bar that fills while each is active. */
export function StepsTrack({ steps }: { steps: Step[] }) {
  const { ref, active } = useCycle(steps.length, STEP_MS);
  return (
    <ol ref={ref} className="mt-12 grid gap-px overflow-hidden rounded-xl border border-line bg-[var(--line)] md:grid-cols-2 xl:grid-cols-4">
      {steps.map((s, i) => {
        const on = i === active;
        return (
          <li key={s.title} className={`reveal relative flex flex-col p-6 transition-colors duration-500 ${on ? 'bg-panel-2' : 'bg-panel'}`} style={{ '--d': i } as CSSProperties}>
            <span className="absolute inset-x-0 top-0 h-0.5 overflow-hidden" aria-hidden="true">
              {on && <span key={active} className="fill block h-full bg-brand-500" style={{ '--ms': `${STEP_MS}ms` } as CSSProperties} />}
            </span>
            <span className={`flex items-center gap-2 font-mono text-[12px] transition-colors duration-500 ${on ? 'text-accent' : 'text-mute'}`}>
              <span className={`grid size-5 place-items-center rounded-full border text-[10.5px] transition-colors duration-500 ${on ? 'border-brand-500 bg-brand-500 text-white' : 'border-line-strong'}`}>{i + 1}</span>
              Step {i + 1}
            </span>
            <h3 className="mt-3 text-[16.5px] font-semibold text-fg">{s.title}</h3>
            <p className="mt-2 flex-1 text-[14px] leading-relaxed text-soft">{s.body}</p>
            <code className={`mt-5 block truncate border-t border-line pt-3 font-mono text-[12px] transition-colors duration-500 ${on ? 'text-accent' : 'text-fg'}`}>
              {s.code}
              {on && <span className="caret ml-0.5 inline-block h-3.5 w-[7px] translate-y-0.5 bg-current" aria-hidden="true" />}
            </code>
          </li>
        );
      })}
    </ol>
  );
}

const PROOF = [
  { label: 'Reading the record from the contract', ms: 1500 },
  { label: 'Checking the enclave and model signatures', ms: 1700 },
  { label: 'Proving finality with a light client proof', ms: 1700 },
  { label: 'Final on NEAR testnet', ms: 5600 },
] as const;
const FINAL = PROOF.length - 1;

/**
 * The hero record's footer: the checks a reader runs, replayed in a loop (read, signatures, light
 * client proof, final), then the SDK call that does the same. Server render and reduced motion show
 * the final state.
 */
export function HeroProof({ block, finalIcon }: { block: string; finalIcon: ReactNode }) {
  const [phase, setPhase] = useState<number>(FINAL);
  useEffect(() => {
    if (reducedMotion()) return;
    let i = -1;
    let timer = 0;
    const next = () => {
      i = (i + 1) % PROOF.length;
      setPhase(i);
      timer = window.setTimeout(next, PROOF[i].ms);
    };
    timer = window.setTimeout(next, 900);
    return () => window.clearTimeout(timer);
  }, []);
  const done = phase === FINAL;
  return (
    <>
      <div className="relative px-4 py-3 sm:px-5">
        <span className="absolute inset-x-0 top-0 h-px overflow-hidden" aria-hidden="true">
          {done ? <span className="block h-full bg-brand-500/60" /> : <span key={phase} className="fill block h-full bg-brand-500" style={{ '--ms': `${PROOF[phase].ms}ms` } as CSSProperties} />}
        </span>
        <p className="sr-only">Final on NEAR testnet, block {block}</p>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1" aria-hidden="true">
          <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-fg">
            {done ? finalIcon : <span className="spinner size-4 shrink-0" />}
            <span key={phase} className="swap truncate">
              {PROOF[phase].label}
            </span>
          </p>
          <p key={done ? 'b' : 's'} className="swap font-mono text-[11.5px] text-mute">
            {done ? `block ${block}` : `check ${phase + 1} of 3`}
          </p>
        </div>
      </div>
      <pre className="overflow-x-auto border-t border-ink-800 bg-[#100e0c] px-4 py-3 text-[11px] leading-[1.75] text-stone-200 sm:px-5 sm:text-[12px] dark:border-line">
        <code>
          <span className="tok-k">const</span> r = <span className="tok-k">await</span> client.<span className="tok-f">proveAttestation</span>(uid);
          {'\n'}r.data.verified;{' '}
          {done ? (
            <span key="t" className="swap inline-block tok-c">
              {'// true'}
            </span>
          ) : (
            <span className="tok-c">
              {'// '}
              <span className="caret inline-block h-3 w-[6px] translate-y-0.5 bg-[#8b8580]" />
            </span>
          )}
        </code>
      </pre>
    </>
  );
}

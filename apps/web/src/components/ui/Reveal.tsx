'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Fades children up when they scroll into view (once). */
export function Reveal({ children, delay = 0, className = '', as: Tag = 'div' }: { children: ReactNode; delay?: number; className?: string; as?: 'div' | 'section' | 'li' }) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.add('reveal');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            window.setTimeout(() => el.classList.add('is-visible'), delay);
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [delay]);
  return (
    <Tag ref={ref as never} className={className}>
      {children}
    </Tag>
  );
}

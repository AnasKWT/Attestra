'use client';

import { useEffect, useState } from 'react';

export function DocsNav({ sections }: { sections: ReadonlyArray<readonly [string, string]> }) {
  const [active, setActive] = useState(sections[0][0]);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActive(vis.target.id);
      },
      { rootMargin: '-80px 0px -70% 0px' },
    );
    for (const [id] of sections) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [sections]);
  return (
    <nav aria-label="Documentation" className="sticky top-24 hidden h-fit w-52 shrink-0 lg:block">
      <p className="mb-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-mute">On this page</p>
      <ul className="space-y-0.5 border-l border-line">
        {sections.map(([id, label]) => (
          <li key={id}>
            <a href={`#${id}`} className={`-ml-px block border-l-2 py-1.5 pl-3 text-[13.5px] transition ${active === id ? 'border-brand-500 font-medium text-fg' : 'border-transparent text-soft hover:text-fg'}`}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

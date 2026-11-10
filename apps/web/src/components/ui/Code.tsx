'use client';

import { useState, type ReactNode } from 'react';
import { CopyButton } from './Copy';

const KEYWORDS = new Set(['import', 'from', 'const', 'let', 'await', 'async', 'return', 'new', 'export', 'function', 'if', 'else', 'true', 'false', 'null', 'for', 'of', 'type', 'interface', 'use', 'fn', 'pub', 'impl', 'mut']);

/** A tiny highlighter for TypeScript, shell and JSON snippets (keywords, strings, numbers, comments, calls). */
export function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\/\/[^\n]*|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d[\d_]*(?:\.\d+)?\b|\b[A-Za-z_][\w]*\b(?=\s*\()|\b[A-Za-z_][\w]*\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const t = m[0];
    let cls = '';
    if (t.startsWith('//') || (t.startsWith('#') && (m.index === 0 || code[m.index - 1] === '\n' || code[m.index - 1] === ' '))) cls = 'tok-c';
    else if (/^["'`]/.test(t)) cls = 'tok-s';
    else if (/^\d/.test(t)) cls = 'tok-n';
    else if (KEYWORDS.has(t)) cls = 'tok-k';
    else if (code[m.index + t.length] === '(' || /^\s*\(/.test(code.slice(m.index + t.length, m.index + t.length + 2))) cls = 'tok-f';
    out.push(cls ? <span key={i++} className={cls}>{t}</span> : t);
    last = m.index + t.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

const WINDOW = 'overflow-hidden rounded-xl border border-ink-800 bg-[#100e0c] shadow-float dark:border-line';
const BAR = 'flex h-11 items-center justify-between gap-3 border-b border-white/[0.07] px-4';

function Body({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto p-4 text-[12.5px] leading-[1.7] text-stone-200">
      <code>{highlight(code)}</code>
    </pre>
  );
}

export function CodeWindow({ title, code, className = '', footer }: { title?: string; code: string; className?: string; footer?: ReactNode }) {
  return (
    <div className={`${WINDOW} ${className}`}>
      <div className={BAR}>
        <span className="truncate font-mono text-[12px] text-stone-400">{title}</span>
        <CopyButton value={code} className="text-stone-400 hover:bg-white/10 hover:text-white" />
      </div>
      <Body code={code} />
      {footer}
    </div>
  );
}

/** One code window with a tab per snippet in its title bar. */
export function CodeTabs({ tabs, className = '' }: { tabs: Array<{ label: string; title?: string; code: string }>; className?: string }) {
  const [active, setActive] = useState(0);
  const tab = tabs[active];
  return (
    <div className={`${WINDOW} ${className}`}>
      <div className={`${BAR} pl-2`}>
        <div role="tablist" className="flex h-full items-stretch">
          {tabs.map((t, i) => (
            <button
              key={t.label}
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={`relative px-3 text-[12.5px] font-medium transition-colors ${i === active ? 'text-white' : 'text-stone-400 hover:text-stone-200'}`}
            >
              {t.label}
              {i === active && <span className="absolute inset-x-3 -bottom-px h-px bg-brand-400" />}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {tab.title && <span className="truncate font-mono text-[12px] text-stone-500">{tab.title}</span>}
          <CopyButton value={tab.code} className="text-stone-400 hover:bg-white/10 hover:text-white" />
        </div>
      </div>
      <Body code={tab.code} />
    </div>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded-md border border-line bg-soft px-1.5 py-0.5 font-mono text-[12.5px] text-fg">{children}</code>;
}

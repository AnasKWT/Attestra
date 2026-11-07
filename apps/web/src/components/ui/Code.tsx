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

export function CodeWindow({ title, code, className = '', footer }: { title?: string; code: string; className?: string; footer?: ReactNode }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-white/10 bg-[#0f0d0b] shadow-float ${className}`}>
      <div className="flex items-center justify-between border-b border-white/[0.07] bg-white/[0.02] px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-[#ff5f57]/90" />
          <span className="size-2.5 rounded-full bg-[#febc2e]/90" />
          <span className="size-2.5 rounded-full bg-[#28c840]/90" />
          {title && <span className="ml-3 font-mono text-[11.5px] text-stone-400">{title}</span>}
        </div>
        <CopyButton value={code} className="text-stone-400 hover:bg-white/10 hover:text-white" />
      </div>
      <pre className="overflow-x-auto p-4 text-[12.5px] leading-[1.7] text-stone-200">
        <code>{highlight(code)}</code>
      </pre>
      {footer}
    </div>
  );
}

export function CodeTabs({ tabs, className = '' }: { tabs: Array<{ label: string; title?: string; code: string }>; className?: string }) {
  const [active, setActive] = useState(0);
  return (
    <div className={className}>
      <div role="tablist" className="mb-3 inline-flex rounded-xl border border-line bg-panel p-1 shadow-panel">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition ${i === active ? 'bg-gradient-to-b from-brand-400 to-brand-600 text-white shadow' : 'text-soft hover:text-fg'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <CodeWindow title={tabs[active].title} code={tabs[active].code} />
    </div>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded-md border border-line bg-soft px-1.5 py-0.5 font-mono text-[12.5px] text-fg">{children}</code>;
}

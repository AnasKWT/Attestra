import type { ComponentProps, ReactNode } from 'react';

const base =
  'w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-[14px] text-fg placeholder:text-mute shadow-[inset_0_1px_2px_rgba(0,0,0,0.03)] outline-none transition focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 disabled:opacity-60';

export function Label({ children, hint, htmlFor }: { children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-end justify-between gap-3 text-[13px] font-medium text-fg">
      <span>{children}</span>
      {hint && <span className="text-[12px] font-normal text-mute">{hint}</span>}
    </label>
  );
}

export function Input({ className = '', ...p }: ComponentProps<'input'>) {
  return <input {...p} className={`${base} h-10 ${className}`} />;
}

export function Textarea({ className = '', ...p }: ComponentProps<'textarea'>) {
  return <textarea {...p} className={`${base} min-h-24 font-mono text-[13px] leading-relaxed ${className}`} />;
}

export function Select({ className = '', children, ...p }: ComponentProps<'select'>) {
  return (
    <select {...p} className={`${base} h-10 appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%238a857f%22 stroke-width=%222%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-[length:14px] bg-[right_12px_center] bg-no-repeat pr-9 ${className}`}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2.5 text-[13.5px] text-fg">
      <span className={`relative h-5 w-9 rounded-full transition ${checked ? 'bg-brand-500' : 'bg-ink-300 dark:bg-ink-700'}`}>
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      {label}
    </label>
  );
}

'use client';

import { Check, Copy, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { truncate } from '@/lib/format';

export function CopyButton({ value, className = '', label = 'Copy' }: { value: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => {
        await navigator.clipboard?.writeText(value);
        setDone(true);
        window.setTimeout(() => setDone(false), 1400);
      }}
      className={`inline-grid size-6 shrink-0 place-items-center rounded-md text-mute transition hover:bg-soft hover:text-fg ${className}`}
    >
      {done ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** A hash or id: truncated, copyable, optionally linked inside the site or out to the explorer. */
export function Hash({ value, href, external, full = false, head = 8, tail = 6, className = '' }: { value: string; href?: string; external?: string; full?: boolean; head?: number; tail?: number; className?: string }) {
  const text = full ? value : truncate(value, head, tail);
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 font-mono text-[12.5px] ${className}`}>
      {href ? (
        <Link href={href} className="truncate text-fg underline-offset-4 hover:text-accent hover:underline" title={value}>
          {text}
        </Link>
      ) : (
        <span className="truncate" title={value}>
          {text}
        </span>
      )}
      <CopyButton value={value} />
      {external && (
        <a href={external} target="_blank" rel="noreferrer" className="inline-grid size-6 place-items-center rounded-md text-mute hover:bg-soft hover:text-fg" aria-label="Open in the explorer" title="Open in NearBlocks">
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </span>
  );
}

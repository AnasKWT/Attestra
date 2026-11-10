'use client';

import { FileCheck2, Landmark, Layers, Search, User } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { SearchResult } from '@attestra/sdk';
import { indexer } from '@/lib/client';
import { readableError } from '@/lib/useFetch';
import { Alert, Badge, Empty } from '../ui/primitives';

const ICON = { schema: Layers, attestation: FileCheck2, authority: Landmark, account: User };
const HREF = (r: SearchResult) => (r.type === 'schema' ? `/schemas/${r.id}` : r.type === 'attestation' ? `/attestations/${r.id}` : r.type === 'authority' ? `/authorities/${encodeURIComponent(r.id)}` : `/accounts/${encodeURIComponent(r.id)}`);

export function SearchView({ initial = '' }: { initial?: string }) {
  const [q, setQ] = useState(initial);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const t = window.setTimeout(() => {
      indexer
        .search(term)
        .then((r) => (setResults(r.results), setErr(null)))
        .catch((e: Error) => setErr(readableError(e.message)));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const shown = q.trim().length < 2 ? null : results;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-2xl border border-line bg-panel px-4 shadow-panel focus-within:border-brand-400 focus-within:ring-4 focus-within:ring-brand-500/10">
        <Search className="size-5 text-mute" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Attestation or schema UID, account id, or schema fields" aria-label="Search" className="h-14 w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-mute" />
      </div>
      {err && q.trim().length >= 2 && <Alert tone="warn" title="The indexer did not answer">{err}</Alert>}
      {shown && shown.length === 0 && <Empty title="No matches" />}
      {shown && shown.length > 0 && (
        <ul className="overflow-hidden rounded-2xl border border-line bg-panel shadow-panel">
          {shown.map((r) => {
            const I = ICON[r.type];
            return (
              <li key={`${r.type}${r.id}`} className="border-b border-line last:border-0">
                <Link href={HREF(r)} className="flex items-center gap-3 px-4 py-3 hover:bg-panel-2">
                  <span className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent"><I className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px] text-fg">{r.id}</span>
                    <span className="block truncate text-[12.5px] text-mute">{r.label}</span>
                  </span>
                  <Badge>{r.type}</Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

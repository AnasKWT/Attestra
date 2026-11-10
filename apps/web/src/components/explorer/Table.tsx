'use client';

import { ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, Empty, Skeleton } from '../ui/primitives';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T>({ columns, rows, loading, error, empty, onRow }: { columns: Column<T>[]; rows: T[] | null; loading: boolean; error?: string | null; empty?: ReactNode; onRow?: (row: T) => string }) {
  if (error) {
    return (
      <Alert tone="warn" title="The indexer did not answer">
        {error.replace(/\.$/, '')}. Lists come from the Attestra indexer; any single record can still be read from the chain on its detail page.
      </Alert>
    );
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-panel">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left">
          <thead>
            <tr className="border-b border-line bg-panel-2">
              {columns.map((c) => (
                <th key={c.key} scope="col" className={`px-4 py-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-mute ${c.className ?? ''}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {columns.map((c) => (
                    <td key={c.key} className="px-4 py-3.5">
                      <Skeleton className="h-4 w-3/4" />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading &&
              rows?.map((r, i) => (
                <tr key={i} className={`border-b border-line text-[13.5px] transition last:border-0 ${onRow ? 'cursor-pointer hover:bg-panel-2' : ''}`} onClick={onRow ? () => (window.location.href = onRow(r)) : undefined}>
                  {columns.map((c) => (
                    <td key={c.key} className={`px-4 py-3 align-middle text-fg ${c.className ?? ''}`}>
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!loading && rows?.length === 0 && <Empty title="Nothing here yet" icon={<Inbox className="size-5" />}>{empty}</Empty>}
    </div>
  );
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="mt-4 flex items-center justify-between text-[13px] text-mute">
      <span>
        {offset + 1} to {Math.min(offset + limit, total)} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1.5">
        <button disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))} className="grid size-8 place-items-center rounded-lg border border-line bg-panel disabled:opacity-40" aria-label="Previous page">
          <ChevronLeft className="size-4" />
        </button>
        <span className="px-2 font-mono text-[12px]">
          {page} / {pages}
        </span>
        <button disabled={page >= pages} onClick={() => onChange(offset + limit)} className="grid size-8 place-items-center rounded-lg border border-line bg-panel disabled:opacity-40" aria-label="Next page">
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

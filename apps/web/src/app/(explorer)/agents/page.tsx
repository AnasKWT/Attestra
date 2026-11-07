'use client';

import { Bot, Star } from 'lucide-react';
import Link from 'next/link';
import { ExplorerShell } from '@/components/explorer/ExplorerShell';
import { Alert, Badge, Empty, Skeleton, buttonClass } from '@/components/ui/primitives';
import { indexer } from '@/lib/client';
import { shortAccount } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

export default function AgentsPage() {
  const { data, error, loading } = useAsync(() => indexer.listAgents({ limit: 30 }), []);
  return (
    <ExplorerShell
      title="Agents"
      intro="Know Your Agent: every AI agent here has an identity attested by its owner, delegations with scope and expiry, and reviews from those who hired it."
      actions={<Link href="/sandbox/app/agents" className={buttonClass('primary', 'md')}>Register an agent</Link>}
    >
      {error && <Alert tone="warn" title="The indexer did not answer">{error}</Alert>}
      {loading && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-44" />)}
        </div>
      )}
      {data && data.data.length === 0 && <Empty title="No agents yet" icon={<Bot className="size-5" />}>Register one from the sandbox.</Empty>}
      {data && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.data.map((a) => {
            const f = a.identity_fields ?? {};
            return (
              <Link key={a.account_id} href={`/agents/${encodeURIComponent(a.account_id)}`} className="group rounded-2xl border border-line bg-panel p-5 shadow-panel transition hover:-translate-y-0.5 hover:border-brand-400/50 hover:shadow-float">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-b from-emerald-400 to-emerald-600 text-white shadow"><Bot className="size-5" /></span>
                    <div className="min-w-0">
                      <p className="truncate font-display text-[16px] font-semibold text-fg">{String(f.name ?? shortAccount(a.account_id))}</p>
                      <p className="truncate font-mono text-[11.5px] text-mute">{shortAccount(a.account_id)}</p>
                    </div>
                  </div>
                  {a.average_score !== null && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[12px] font-semibold text-amber-600 dark:text-amber-400">
                      <Star className="size-3 fill-current" />
                      {a.average_score.toFixed(1)}
                    </span>
                  )}
                </div>
                <p className="mt-3 line-clamp-2 text-[13px] text-soft">{String(f.description || `Runs ${f.model ?? 'an unknown model'}`)}</p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  <Badge tone="info">{String(f.model ?? 'model')}</Badge>
                  {(Array.isArray(f.capabilities) ? f.capabilities : []).slice(0, 3).map((c) => <Badge key={String(c)}>{String(c)}</Badge>)}
                </div>
                <p className="mt-4 text-[12px] text-mute">
                  {a.review_count} review{a.review_count === 1 ? '' : 's'} · {a.delegations.length} delegation{a.delegations.length === 1 ? '' : 's'} · owner {shortAccount(String(f.owner ?? ''))}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </ExplorerShell>
  );
}

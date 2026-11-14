'use client';

import { Bot, Star } from 'lucide-react';
import Link from 'next/link';
import { IdentityStatusBadge, TrustBadge } from '@/components/explorer/AgentReputation';
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
      intro="Know Your Agent: every AI agent here has an identity attestation, delegations with scope and expiry, and reviews. An identity is verified when the agent account or its parent registered it, a review is paid when it names the reviewer's payment to the agent, and an agent is trusted with a verified identity and paid reviews averaging at least 3.5."
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
              <Link key={a.account_id} href={`/agents/${encodeURIComponent(a.account_id)}`} className="group rounded-xl border border-line bg-panel p-5 shadow-panel transition-colors hover:border-line-strong hover:bg-panel-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-soft text-soft"><Bot className="size-5" /></span>
                    <div className="min-w-0">
                      <p className="truncate font-display text-[16px] font-semibold text-fg">{String(f.name ?? shortAccount(a.account_id))}</p>
                      <p className="truncate font-mono text-[11.5px] text-mute">{shortAccount(a.account_id)}</p>
                    </div>
                  </div>
                  {a.average_score !== null && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-semibold tabular-nums text-fg" title="Average of the reviews that count, out of 5">
                      <Star className="size-3.5 fill-amber-500 text-amber-500" aria-hidden="true" />
                      {a.average_score.toFixed(1)}
                    </span>
                  )}
                </div>
                <p className="mt-3 line-clamp-2 text-[13px] text-soft">{String(f.description || `Runs ${f.model ?? 'an unknown model'}`)}</p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  <IdentityStatusBadge status={a.identity_status} reason={a.identity_reason} />
                  {a.trusted && <TrustBadge profile={a} />}
                  <Badge tone="info">{String(f.model ?? 'model')}</Badge>
                  {(Array.isArray(f.capabilities) ? f.capabilities : []).slice(0, 3).map((c) => <Badge key={String(c)}>{String(c)}</Badge>)}
                </div>
                <p className="mt-4 text-[12px] text-mute">
                  {a.review_count} review{a.review_count === 1 ? '' : 's'} ({a.paid_review_count ?? 0} paid) · {a.delegations.length} delegation{a.delegations.length === 1 ? '' : 's'} · owner {shortAccount(String(f.owner ?? ''))}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </ExplorerShell>
  );
}

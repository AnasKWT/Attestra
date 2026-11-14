'use client';

import { Star } from 'lucide-react';
import Link from 'next/link';
import { IdentityStatusBadge, ReviewStanding, TrustBadge, TrustReasons } from '@/components/explorer/AgentReputation';
import { ExplorerShell } from '@/components/explorer/ExplorerShell';
import { AccountLink, UidLink } from '@/components/explorer/Links';
import { Alert, Badge, Empty, KeyValue, Panel, PanelHeader, Skeleton, StatusBadge, buttonClass } from '@/components/ui/primitives';
import { indexer } from '@/lib/client';
import { formatTime, timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex text-amber-500" aria-label={`${n} of 5`}>
      {Array.from({ length: 5 }, (_, i) => <Star key={i} className={`size-3.5 ${i < Math.round(n) ? 'fill-current' : 'opacity-30'}`} />)}
    </span>
  );
}

export function AgentDetail({ account }: { account: string }) {
  const { data, error, loading } = useAsync(() => indexer.getAgent(account), [account]);
  const f = data?.identity_fields ?? {};
  return (
    <ExplorerShell
      title={String(f.name ?? account)}
      intro={<span className="font-mono text-[13px]">{account}</span>}
      actions={<Link href={`/sandbox/app/agents?agent=${encodeURIComponent(account)}`} className={buttonClass('secondary', 'md')}>Review this agent</Link>}
    >
      {error && <Alert tone="warn" title={error.startsWith('not found') ? 'Not an indexed agent' : 'The indexer did not answer'}>{error}</Alert>}
      {loading && <Skeleton className="h-72 w-full" />}
      {data && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="space-y-6">
            <Panel>
              <PanelHeader
                title="Identity"
                subtitle="Verified when the agent or its parent registered it"
                right={<span className="flex items-center gap-1.5">{data.identity && <StatusBadge status={data.identity.status} />}<IdentityStatusBadge status={data.identity_status} reason={data.identity_reason} /></span>}
              />
              {data.identity_status === 'unverified' && data.identity_reason && (
                <div className="px-5 pt-4">
                  <Alert tone="warn" title="Not provably the owner's">{data.identity_reason}</Alert>
                </div>
              )}
              {data.identity ? (
                <dl className="px-5 py-2">
                  <KeyValue label="Owner"><AccountLink id={String(f.owner)} /></KeyValue>
                  <KeyValue label="Model"><Badge tone="info">{String(f.model)}</Badge></KeyValue>
                  <KeyValue label="Capabilities"><div className="flex flex-wrap gap-1.5">{(Array.isArray(f.capabilities) ? f.capabilities : []).map((c) => <Badge key={String(c)}>{String(c)}</Badge>)}</div></KeyValue>
                  <KeyValue label="Endpoint">{f.endpoint ? <span className="break-all font-mono text-[12.5px]">{String(f.endpoint)}</span> : 'none'}</KeyValue>
                  {f.description ? <KeyValue label="About">{String(f.description)}</KeyValue> : null}
                  <KeyValue label="Attestation"><UidLink uid={data.identity.uid} kind="attestations" /></KeyValue>
                  <KeyValue label="Attester"><AccountLink id={data.identity.attester} /></KeyValue>
                  <KeyValue label="Since">{formatTime(data.identity.created_at)}</KeyValue>
                </dl>
              ) : (
                <Empty title="This account has no identity attestation" />
              )}
            </Panel>
            <Panel>
              <PanelHeader title="Delegations held" subtitle="What this agent may attest, for whom, until when" />
              {data.delegations.length === 0 ? (
                <Empty title="No delegations" />
              ) : (
                <ul className="divide-y divide-[var(--line)]">
                  {data.delegations.map((d, i) => (
                    <li key={i} className="px-5 py-3 text-[13px]">
                      <p>
                        for <AccountLink id={String(d.authority)} />
                      </p>
                      <p className="text-[12px] text-mute">
                        {d.schemas ? `${(d.schemas as string[]).length} schemas` : 'any schema'} · {Number(d.max_uses) ? `${d.uses}/${d.max_uses} uses` : `${d.uses} uses`} · {Number(d.expires_at) ? `until ${formatTime(Number(d.expires_at))}` : 'no expiry'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
          <Panel>
            <PanelHeader
              title="Reputation"
              subtitle="One per reviewer, never by the agent or its owner"
              right={data.average_score !== null && <span className="flex items-center gap-2 text-[13px] font-semibold text-fg"><Stars n={data.average_score} />{data.average_score.toFixed(2)} from {data.review_count}</span>}
            />
            <div className="space-y-3 border-b border-line px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-soft">
                <TrustBadge profile={data} />
                <span>
                  <b className="font-semibold text-fg">{data.paid_review_count ?? 0}</b> paid{data.paid_average_score != null && <>, average <b className="font-semibold text-fg">{data.paid_average_score.toFixed(2)}</b></>}
                </span>
                <span>
                  <b className="font-semibold text-fg">{(data.review_count ?? 0) - (data.paid_review_count ?? 0)}</b> unpaid
                </span>
                <span>
                  <b className="font-semibold text-fg">{data.excluded_review_count ?? 0}</b> not counted
                </span>
              </div>
              {!data.trusted && <TrustReasons reasons={data.trust_reasons ?? []} />}
            </div>
            {data.reviews.length === 0 ? (
              <Empty title="No reviews yet" />
            ) : (
              <ul className="divide-y divide-[var(--line)]">
                {data.reviews.map((r) => (
                  <li key={r.uid} className="px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Stars n={Number(r.fields?.score ?? 0)} />
                        <AccountLink id={r.attester} />
                      </div>
                      <span className="text-[12px] text-mute">{timeAgo(r.created_at)}</span>
                    </div>
                    {r.fields?.comment ? <p className="mt-2 text-[13.5px] text-fg">{String(r.fields.comment)}</p> : null}
                    {r.fields?.job_ref ? <p className="mt-1 break-all font-mono text-[12px] text-mute">job_ref {String(r.fields.job_ref)}</p> : null}
                    {r.status !== 'active' && <div className="mt-2"><StatusBadge status={r.status} /></div>}
                    {r.status === 'active' && <ReviewStanding review={r} />}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </ExplorerShell>
  );
}

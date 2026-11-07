'use client';

import { Bot, KeyRound, Star } from 'lucide-react';
import Link from 'next/link';
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
      {error && <Alert tone="warn">{error}</Alert>}
      {loading && <Skeleton className="h-72 w-full" />}
      {data && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          <div className="space-y-6">
            <Panel glow>
              <PanelHeader icon={<Bot className="size-4" />} title="Identity" subtitle="Attested by the owner under the agent identity schema" right={data.identity ? <StatusBadge status={data.identity.status} /> : <Badge tone="warn">no identity</Badge>} />
              {data.identity ? (
                <dl className="px-5 py-2">
                  <KeyValue label="Owner"><AccountLink id={String(f.owner)} /></KeyValue>
                  <KeyValue label="Model"><Badge tone="info">{String(f.model)}</Badge></KeyValue>
                  <KeyValue label="Capabilities"><div className="flex flex-wrap gap-1.5">{(Array.isArray(f.capabilities) ? f.capabilities : []).map((c) => <Badge key={String(c)}>{String(c)}</Badge>)}</div></KeyValue>
                  <KeyValue label="Endpoint">{f.endpoint ? <span className="break-all font-mono text-[12.5px]">{String(f.endpoint)}</span> : 'none'}</KeyValue>
                  {f.description ? <KeyValue label="About">{String(f.description)}</KeyValue> : null}
                  <KeyValue label="Attestation"><UidLink uid={data.identity.uid} kind="attestations" /></KeyValue>
                  <KeyValue label="Since">{formatTime(data.identity.created_at)}</KeyValue>
                </dl>
              ) : (
                <Empty title="This account has no identity attestation" />
              )}
            </Panel>
            <Panel>
              <PanelHeader icon={<KeyRound className="size-4" />} title="Delegations held" subtitle="What this agent may attest, for whom, until when" />
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
              icon={<Star className="size-4" />}
              title="Reputation"
              subtitle="Reviews from people and agents who hired it"
              right={data.average_score !== null && <span className="flex items-center gap-2 text-[13px] font-semibold text-fg"><Stars n={data.average_score} />{data.average_score.toFixed(2)} from {data.review_count}</span>}
            />
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
                    {r.fields?.job_ref ? <p className="mt-1 text-[12px] text-mute">Job: {String(r.fields.job_ref)}</p> : null}
                    {r.status !== 'active' && <div className="mt-2"><StatusBadge status={r.status} /></div>}
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

'use client';

import { BadgeCheck } from 'lucide-react';
import type { DelegateRecord } from '@attestra/sdk';
import { ExplorerShell } from '@/components/explorer/ExplorerShell';
import { AccountLink } from '@/components/explorer/Links';
import { Hash } from '@/components/ui/Copy';
import { Alert, Badge, Empty, KeyValue, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import { reader } from '@/lib/client';
import { accountUrl } from '@/lib/config';
import { formatAmount, formatTime } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

export function AuthorityDetail({ account }: { account: string }) {
  const c = reader();
  const a = useAsync(async () => {
    const r = await c.getAuthority(account);
    if (!r.success || !r.data) throw new Error(r.error?.message ?? 'not found');
    const d = await c.getDelegates(account);
    const ms = account.startsWith('ms-') ? await c.getMultisig(account) : null;
    return { auth: r.data, delegates: d.data?.delegates ?? [], multisig: ms?.data ?? null };
  }, [account]);
  return (
    <ExplorerShell title={account} intro={<Hash value={account} external={accountUrl(account)} full />}>
      {a.error && <Alert tone="bad" title="Not a registered authority">{a.error}</Alert>}
      {a.loading && <Skeleton className="h-64 w-full" />}
      {a.data && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Authority" right={a.data.auth.verified ? <Badge tone="ok"><BadgeCheck className="size-3" />verified by governance</Badge> : <Badge>not verified</Badge>} />
            <dl className="px-5 py-2">
              <KeyValue label="About">{a.data.auth.metadata}</KeyValue>
              <KeyValue label="Kind">{a.data.auth.kind}</KeyValue>
              <KeyValue label="Registered">{formatTime(a.data.auth.registered_at)}</KeyValue>
              {a.data.auth.verified && <KeyValue label="Verified">{formatTime(a.data.auth.verified_at)}</KeyValue>}
              <KeyValue label="Staking tier">{a.data.auth.tier ? <Badge tone="brand">{a.data.auth.tier}</Badge> : 'none'}</KeyValue>
              <KeyValue label="Staked">{formatAmount(a.data.auth.staked, 18)} tATT</KeyValue>
            </dl>
            {a.data.multisig && (
              <div className="border-t border-line px-5 py-4">
                <p className="text-[13px] font-medium text-fg">
                  {a.data.multisig.threshold} of {a.data.multisig.members.length} members must approve
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {a.data.multisig.members.map((m) => (
                    <AccountLink key={m} id={m} className="rounded-md border border-line bg-soft px-2 py-1" />
                  ))}
                </div>
              </div>
            )}
          </Panel>
          <Panel>
            <PanelHeader title="Delegates" subtitle="Employees, agents and systems that may attest for this authority" />
            {a.data.delegates.length === 0 ? (
              <Empty title="No delegates" />
            ) : (
              <ul className="divide-y divide-[var(--line)]">
                {a.data.delegates.map((d: DelegateRecord) => (
                  <li key={d.delegate} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[13px]">
                    <div className="min-w-0">
                      <AccountLink id={d.delegate} />
                      <p className="text-[12px] text-mute">
                        {d.label || 'delegate'} · {d.schemas ? `${d.schemas.length} schema${d.schemas.length > 1 ? 's' : ''}` : 'any schema'} · {d.max_uses ? `${d.uses}/${d.max_uses} uses` : `${d.uses} uses`} · {d.expires_at ? `until ${formatTime(d.expires_at)}` : 'no expiry'}
                        {d.can_revoke ? ' · may revoke' : ''}
                      </p>
                    </div>
                    <Badge tone={d.active ? 'ok' : 'neutral'}>{d.active ? 'active' : 'inactive'}</Badge>
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

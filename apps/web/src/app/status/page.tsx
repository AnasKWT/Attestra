'use client';

import { Activity, AlertTriangle, CheckCircle2, Server, Wallet, XCircle } from 'lucide-react';
import { Alert, Badge, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import { AGENT_URL, INDEXER_URL, KEEPER_URL, NETWORK, RELAYER_URL, TOPUP_URL } from '@/lib/config';
import { formatAmount } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

const SERVICES = [
  ['Indexer', INDEXER_URL],
  ['Relayer', RELAYER_URL],
  ['Agent', AGENT_URL],
  ['Keeper', KEEPER_URL],
  ['Top-up', TOPUP_URL],
] as const;

interface Balances {
  accounts: Array<{ account: string; balance: string; min: string; target: string; low: boolean }>;
  treasury: { account: string; balance: string };
  treasury_low: boolean;
}

async function health(url: string) {
  try {
    const res = await fetch(`${url}/health`, { cache: 'no-store' });
    const body = (await res.json()) as Record<string, unknown>;
    return { ok: res.ok && body.ok !== false, body };
  } catch (e) {
    // fetch throws a TypeError ("Failed to fetch") when the service cannot be reached at all.
    return { ok: false, body: { reason: e instanceof TypeError ? 'not reachable' : (e as Error).message } };
  }
}

export default function Status() {
  const svc = useAsync(() => Promise.all(SERVICES.map(([, u]) => health(u))), []);
  const bal = useAsync(async () => {
    const r = await fetch(`${TOPUP_URL}/api/balances`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`top-up answered ${r.status}`);
    return (await r.json()) as Balances;
  }, []);
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold text-fg">Status</h1>
      <p className="mt-2 text-[14.5px] text-soft">Live health of every Attestra service on NEAR {NETWORK}, and the balances the top-up service keeps funded.</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {SERVICES.map(([name], i) => {
          const h = svc.data?.[i];
          return (
            <Panel key={name} className="p-4">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-[14px] font-semibold text-fg"><Server className="size-4 text-mute" />{name}</span>
                {!h ? <Skeleton className="h-4 w-4 rounded-full" /> : h.ok ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-red-500" />}
              </div>
              <p className="mt-2 line-clamp-2 text-[12px] text-mute">{h ? (h.ok ? 'healthy' : String(h.body.reason ?? h.body.error ?? 'unhealthy')) : 'checking'}</p>
              {typeof h?.body.lag_blocks === 'number' && <p className="mt-1 text-[12px] text-soft">lag {String(h.body.lag_blocks)} blocks</p>}
            </Panel>
          );
        })}
      </div>
      <Panel className="mt-8">
        <PanelHeader icon={<Wallet className="size-4" />} title="Service wallets" subtitle="Refilled from the treasury within a daily cap" right={bal.data && (bal.data.treasury_low ? <Badge tone="bad"><AlertTriangle className="size-3" />treasury low</Badge> : <Badge tone="ok">treasury ok</Badge>)} />
        {bal.error && <div className="p-5"><Alert tone="warn" title="The top-up service did not answer">{bal.error}</Alert></div>}
        {bal.data && (
          <ul className="divide-y divide-[var(--line)]">
            {[{ account: bal.data.treasury.account, balance: bal.data.treasury.balance, min: '', target: '', low: bal.data.treasury_low }, ...bal.data.accounts].map((a) => (
              <li key={a.account} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-[13.5px]">
                <span className="font-mono text-[12.5px] text-fg">{a.account}</span>
                <span className="flex items-center gap-3">
                  {a.min && <span className="text-[12px] text-mute">min {formatAmount(a.min)} / target {formatAmount(a.target)}</span>}
                  <span className="font-mono tabular-nums text-fg">{formatAmount(a.balance)} NEAR</span>
                  {a.low && <Badge tone="warn">low</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <p className="mt-4 flex items-center gap-2 text-[12px] text-mute"><Activity className="size-3.5" />Each service also answers /live for liveness probes.</p>
    </div>
  );
}

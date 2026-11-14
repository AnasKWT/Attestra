/** The top-up's HTTP API: `/api/balances` for the status page, `POST /v1/run`, `/live`, `/health`. */

import { TokenBucket } from 'attestra';
import type { ChainWriter } from '../lib/chain';
import { baseApp, limited, type HealthReport } from '../lib/http';
import type { RecentErrors } from '../lib/log';
import { formatNear } from '../lib/units';
import type { TopUpConfig } from './config';
import { belowMin } from './plan';
import type { Snapshot, TopUp } from './topup';

export function balancesView(config: TopUpConfig, s: Snapshot, dailyUsed: bigint, day: string) {
  const near = (v: bigint | null) => (v === null ? null : formatNear(v));
  const row = (r: Snapshot['readings'][number]) => ({
    account: r.account,
    ...(r.contract ? { contract: r.contract } : {}),
    balance_near: r.kind === 'storage' && r.balance === null && !r.error ? '0' : near(r.balance),
    min_near: formatNear(r.min),
    target_near: formatNear(r.target),
    below_min: belowMin(r),
    ...(r.error ? { error: r.error } : {}),
  });
  const treasuryLow = s.treasury === null || s.treasury < config.treasuryWarn;
  return {
    network: config.network,
    read_at: s.at,
    treasury: {
      account: config.accountId,
      balance_near: near(s.treasury),
      warn_near: formatNear(config.treasuryWarn),
      low: treasuryLow,
      ...(s.treasuryError ? { error: s.treasuryError } : {}),
    },
    treasury_low: treasuryLow,
    accounts: s.readings.filter((r) => r.kind === 'account').map(row),
    storage: s.readings.filter((r) => r.kind === 'storage').map(row),
    daily: { day, used_near: formatNear(dailyUsed), cap_near: formatNear(config.dailyCap) },
  };
}

export function createTopUpApp(deps: { config: TopUpConfig; topup: TopUp; writer: ChainWriter | null; errors: RecentErrors }) {
  const { config, topup, writer, errors } = deps;

  async function health(): Promise<HealthReport> {
    const view = balancesView(config, await topup.current(), topup.dailyUsed, topup.day);
    const reasons: string[] = [];
    if (!writer) reasons.push(config.idleReason ?? 'idle');
    if (view.treasury.error) reasons.push(`treasury: ${view.treasury.error}`);
    else if (view.treasury_low) reasons.push(`treasury below ${view.treasury.warn_near} NEAR`);
    const low = [...view.accounts, ...view.storage].filter((r) => r.below_min).map((r) => r.account);
    if (low.length) reasons.push(`below minimum: ${low.join(', ')}`);
    const unreadable = [...view.accounts, ...view.storage].filter((r) => 'error' in r || r.balance_near === null).map((r) => r.account);
    if (unreadable.length) reasons.push(`unreadable or missing: ${unreadable.join(', ')}`);
    return {
      ok: reasons.length === 0,
      ...(reasons.length ? { reason: reasons.join('; ') } : {}),
      service: 'topup',
      mode: writer ? 'active' : 'idle',
      interval_ms: config.intervalMs,
      ...view,
      last_run: topup.lastRun,
      recent_errors: errors.list(),
    };
  }

  const app = baseApp(health);
  // Per client address: each answer reads every watched balance from the chain; a run can send NEAR.
  app.get('/api/balances', limited(config.trustProxy, 'balance reads', { limiter: new TokenBucket(config.rates.balancesIp) }));
  app.on('POST', '/v1/run', limited(config.trustProxy, 'top-up runs', { limiter: new TokenBucket(config.rates.runIp) }));
  app.get('/api/balances', async (c) => c.json({ ...balancesView(config, await topup.current(), topup.dailyUsed, topup.day), last_run: topup.lastRun }));
  // Runs now, at most every 30 seconds; otherwise answers with the last run.
  app.post('/v1/run', async (c) => {
    const last = topup.lastRun;
    if (last && Date.now() - Date.parse(last.at) < 30_000) return c.json(last);
    return c.json(await topup.run('request'));
  });
  return app;
}

/** The keeper's HTTP API: `/live`, `/health` (last pass, drift, lag, balance) and `POST /v1/run`. */

import { errorMessage } from '@attestra/sdk';
import { withTimeout, type ChainReader, type ChainWriter } from '../lib/chain';
import { baseApp, type HealthReport } from '../lib/http';
import type { RecentErrors } from '../lib/log';
import { formatNear } from '../lib/units';
import type { KeeperConfig } from './config';
import type { Keeper } from './keeper';

export function createKeeperApp(deps: { config: KeeperConfig; keeper: Keeper; reader: ChainReader; writer: ChainWriter | null; errors: RecentErrors; startedAt?: number }) {
  const { config, keeper, reader, writer, errors } = deps;
  const startedAt = deps.startedAt ?? Date.now();

  async function health(): Promise<HealthReport> {
    let balance: bigint | null = null;
    let balanceError: string | undefined;
    try {
      balance = await withTimeout(reader.balance(config.accountId), 5000, 'balance read');
    } catch (e) {
      balanceError = errorMessage(e);
    }
    const last = keeper.last;
    const reasons: string[] = [];
    if (!writer) reasons.push(config.idleReason ?? 'idle');
    else if (balanceError) reasons.push(`balance unreadable: ${balanceError}`);
    else if (balance === null) reasons.push(`${config.accountId} does not exist`);
    else if (balance < config.lowBalance) reasons.push(`balance below ${formatNear(config.lowBalance)} NEAR`);
    if (!last) {
      if (Date.now() - startedAt > 2 * config.intervalMs) reasons.push('no pass has finished yet');
    } else {
      if (last.drift.length) reasons.push(`${last.drift.length} drift mismatches between the indexer and the chain`);
      if (last.lag_blocks === null) reasons.push('indexer lag unknown');
      else if (last.lag_blocks > config.maxLagBlocks) reasons.push(`indexer lag ${last.lag_blocks} blocks (max ${config.maxLagBlocks})`);
      if (!keeper.lastDriftAt || keeper.lastDriftAt !== last.at) reasons.push('the last drift check failed');
      if (Date.now() - Date.parse(last.at) > 3 * config.intervalMs) reasons.push('the last pass is stale');
    }
    return {
      ok: reasons.length === 0,
      ...(reasons.length ? { reason: reasons.join('; ') } : {}),
      service: 'keeper',
      network: config.network,
      mode: writer ? 'active' : 'read-only',
      account: config.accountId,
      balance_near: balance === null ? null : formatNear(balance),
      interval_ms: config.intervalMs,
      last_pass: last,
      lag_blocks: last?.lag_blocks ?? null,
      max_lag_blocks: config.maxLagBlocks,
      drift: last?.drift ?? [],
      queue: { length: writer?.queueLength() ?? 0 },
      recent_errors: errors.list(),
    };
  }

  const app = baseApp(health);
  // Runs a pass now, at most every 10 seconds; otherwise answers with the last one.
  app.post('/v1/run', async (c) => {
    const last = keeper.last;
    if (last && Date.now() - Date.parse(last.at) < 10_000) return c.json(last);
    return c.json(await keeper.tick());
  });
  return app;
}

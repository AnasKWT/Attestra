/**
 * The keeper's HTTP API: `/live`, `/health` (last pass, drift, lag, balance), `POST /v1/run`,
 * `GET /v1/dao` and `POST /v1/dao/membership` (a DAO membership issued by the keeper as the DAO's
 * scoped delegate, for an account that signed its own request).
 */

import { errorMessage, TokenBucket, tooManyRequests } from 'attestra';
import { withTimeout, type ChainReader, type ChainWriter } from '../lib/chain';
import { baseApp, limited, type HealthReport } from '../lib/http';
import type { RecentErrors } from '../lib/log';
import { formatNear } from '../lib/units';
import type { KeeperConfig } from './config';
import { Refusal, type MembershipDesk } from './council';
import type { Keeper } from './keeper';

export function createKeeperApp(deps: { config: KeeperConfig; keeper: Keeper; desk?: MembershipDesk; reader: ChainReader; writer: ChainWriter | null; errors: RecentErrors; startedAt?: number }) {
  const { config, keeper, desk, reader, writer, errors } = deps;
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
      dao_membership: desk?.info() ?? null,
      recent_errors: errors.list(),
    };
  }

  const app = baseApp(health);
  // Per client address: a pass and a DAO request read the chain and the indexer and can send transactions.
  app.on('POST', '/v1/run', limited(config.trustProxy, 'keeper passes', { limiter: new TokenBucket(config.rates.runIp) }));
  app.on('POST', '/v1/dao/*', limited(config.trustProxy, 'DAO requests', { limiter: new TokenBucket(config.rates.daoIp) }));
  // Per account: counted only when a membership is issued (a signed request), so nobody can use up
  // another account's limit; it also stops a second issue while the indexer has not seen the first.
  const memberships = new TokenBucket(config.rates.membershipAccount);
  const accountOf = (message: string): string | undefined => {
    try {
      const account = (JSON.parse(message) as { account?: unknown }).account;
      return typeof account === 'string' ? account : undefined;
    } catch {
      return undefined;
    }
  };
  // Runs a pass now, at most every 10 seconds; otherwise answers with the last one.
  app.post('/v1/run', async (c) => {
    const last = keeper.last;
    if (last && Date.now() - Date.parse(last.at) < 10_000) return c.json(last);
    return c.json(await keeper.tick());
  });
  app.get('/v1/dao', (c) => c.json(desk?.info() ?? { daos: [] }));
  app.post('/v1/dao/membership', async (c) => {
    if (!desk || !writer || !config.daos.length) return c.json({ error: writer ? 'no DAO to issue for (KEEPER_DAOS)' : config.idleReason ?? 'read-only' }, 503);
    const body = (await c.req.json().catch(() => null)) as { request?: unknown } | null;
    const request = body?.request as Parameters<MembershipDesk['request']>[0] | undefined;
    if (!request || typeof request.message !== 'string') return c.json({ error: 'request is the account\'s signed membership request' }, 400);
    const account = accountOf(request.message);
    const quota = account ? memberships.peek(account) : null;
    if (account && quota && !quota.ok) return tooManyRequests({ ...quota, refused: { limiter: memberships, key: account, scope: 'for one account' } }, 'memberships');
    try {
      const issued = await desk.request(request);
      memberships.take(issued.account);
      return c.json(issued);
    } catch (e) {
      if (e instanceof Refusal) return c.json({ error: e.message }, e.status);
      errors.add(`membership request: ${errorMessage(e)}`);
      return c.json({ error: errorMessage(e) }, 502);
    }
  });
  return app;
}

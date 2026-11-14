/** Top-up settings: the watched wallets, the verdicts contract's storage balance and the treasury limits. */

import { isValidAccountId } from 'near-kit';
import type { Rate } from 'attestra';
import { int, loadServiceConfig, rate, type ServiceConfig } from '../lib/config';
import { parseNear } from '../lib/units';

export interface Watch {
  kind: 'account' | 'storage';
  account: string;
  /** For `storage`: the contract holding the NEP-145 balance. */
  contract?: string;
  min: bigint;
  target: bigint;
}

export interface TopUpConfig extends ServiceConfig {
  intervalMs: number;
  watches: Watch[];
  dailyCap: bigint;
  /** `treasury_low` below this. */
  treasuryWarn: bigint;
  /** Never spend the treasury below this (it pays its own gas). */
  treasuryReserve: bigint;
  /** Per client address: POST /v1/run and GET /api/balances. */
  rates: { runIp: Rate; balancesIp: Rate };
}

/** Parses `account:min:target` triples (NEAR), comma-separated. */
export function parseAccounts(text: string): Watch[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((triple) => {
      const [account, min, target, extra] = triple.split(':').map((s) => s.trim());
      if (!account || !min || !target || extra !== undefined) throw new Error(`TOPUP_ACCOUNTS entry "${triple}" must be account:min:target`);
      if (!isValidAccountId(account)) throw new Error(`TOPUP_ACCOUNTS: invalid account id "${account}"`);
      const w: Watch = { kind: 'account', account, min: parseNear(min), target: parseNear(target) };
      if (w.target < w.min) throw new Error(`TOPUP_ACCOUNTS: target below min for ${account}`);
      return w;
    });
}

export function loadTopUpConfig(env: NodeJS.ProcessEnv = process.env): TopUpConfig {
  const base = loadServiceConfig('topup', env);
  const r = base.root;
  const accounts = parseAccounts(env.TOPUP_ACCOUNTS || `relayer.${r}:3:6,keeper.${r}:1:2,agent.${r}:2:4`);
  return {
    ...base,
    intervalMs: Math.max(10_000, int(env.TOPUP_INTERVAL_MS, 600_000)),
    watches: [
      ...accounts,
      { kind: 'storage', account: base.net.contracts.verdicts, contract: base.net.contracts.attestations, min: parseNear('0.3'), target: parseNear('1') },
    ],
    dailyCap: parseNear(env.TOPUP_DAILY_CAP_NEAR || '10'),
    treasuryWarn: parseNear(env.TREASURY_WARN_NEAR || '15'),
    treasuryReserve: parseNear('0.5'),
    rates: { runIp: rate(env, 'TOPUP_RATE_RUN_IP', '5/1h'), balancesIp: rate(env, 'TOPUP_RATE_BALANCES_IP', '60/1m') },
  };
}

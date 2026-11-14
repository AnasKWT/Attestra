/** Relayer settings: the shared ones plus policy limits and the optional gas key. */

import type { Rate } from 'attestra';
import { int, loadServiceConfig, rate, type ServiceConfig } from '../lib/config';
import { parseNear } from '../lib/units';

export interface RelayerConfig extends ServiceConfig {
  /** Attesters the relayer submits for; empty means anyone. */
  allowlist: Set<string>;
  dailyPerAttester: number;
  dailyTotal: number;
  /** yoctoNEAR the relayer may spend per day on attesters' storage. */
  storageBudget: bigint;
  metaDailyPerSender: number;
  metaDailyTotal: number;
  gasKey?: string;
  gasKeyLanes: number;
  /** `/health` reports `ok: false` below this balance (yoctoNEAR). */
  lowBalance: bigint;
  /** Per client address: every POST /v1/* request, and the sponsorships that spend (storage deposits, passkey funding). */
  rates: { requestsIp: Rate; sponsorIp: Rate };
}

export function loadRelayerConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const base = loadServiceConfig('relayer', env);
  const list = (env.RELAYER_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ...base,
    allowlist: new Set(list),
    dailyPerAttester: int(env.RELAYER_DAILY_PER_ATTESTER, 50),
    dailyTotal: int(env.RELAYER_DAILY_TOTAL, 500),
    storageBudget: parseNear(env.RELAYER_STORAGE_BUDGET_NEAR || '2'),
    metaDailyPerSender: int(env.RELAYER_META_DAILY_PER_SENDER, 50),
    metaDailyTotal: int(env.RELAYER_META_DAILY_TOTAL, 500),
    gasKey: env.RELAYER_GAS_KEY?.trim() || undefined,
    gasKeyLanes: int(env.RELAYER_GAS_KEY_LANES, 0),
    lowBalance: parseNear(env.RELAYER_LOW_BALANCE_NEAR || '1'),
    rates: { requestsIp: rate(env, 'RELAYER_RATE_IP', '60/10m'), sponsorIp: rate(env, 'RELAYER_RATE_SPONSOR_IP', '20/1d') },
  };
}

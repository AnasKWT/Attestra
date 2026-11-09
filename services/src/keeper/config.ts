/** Keeper settings: the shared ones plus its interval and drift thresholds. */

import { int, loadServiceConfig, type ServiceConfig } from '../lib/config';
import { parseNear } from '../lib/units';

export interface KeeperConfig extends ServiceConfig {
  intervalMs: number;
  /** Indexer lag (blocks) above which `/health` reports `ok: false`. */
  maxLagBlocks: number;
  /** Most transactions sent per pass. */
  maxPerTick: number;
  /** Newest attestations compared with the chain per pass. */
  driftSample: number;
  lowBalance: bigint;
}

export function loadKeeperConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  return {
    ...loadServiceConfig('keeper', env),
    intervalMs: Math.max(1000, int(env.KEEPER_INTERVAL_MS, 30_000)),
    maxLagBlocks: int(env.KEEPER_MAX_LAG_BLOCKS, 300),
    maxPerTick: Math.max(1, int(env.KEEPER_MAX_PER_TICK, 20)),
    driftSample: Math.max(1, int(env.KEEPER_DRIFT_SAMPLE, 20)),
    lowBalance: parseNear(env.KEEPER_LOW_BALANCE_NEAR || '0.5'),
  };
}

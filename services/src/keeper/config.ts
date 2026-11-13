/** Keeper settings: the shared ones plus its interval and drift thresholds. */

import { DEFAULT_ROOTS, DEPLOYMENT_DAOS } from '@attestra/sdk';
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
  /** Sputnik DAOs the keeper reviews membership proposals for, as a reviewer or council member. */
  daos: string[];
  /** Membership roles the keeper approves without a human vote. */
  daoRoles: string[];
}


/** A comma-separated list; unset or empty keeps the default, `none` clears it. */
function list(v: string | undefined, fallback: string[]): string[] {
  if (v === undefined || !v.trim()) return fallback;
  if (v.trim() === 'none') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadKeeperConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  const base = loadServiceConfig('keeper', env);
  return {
    ...base,
    intervalMs: Math.max(1000, int(env.KEEPER_INTERVAL_MS, 30_000)),
    maxLagBlocks: int(env.KEEPER_MAX_LAG_BLOCKS, 300),
    maxPerTick: Math.max(1, int(env.KEEPER_MAX_PER_TICK, 20)),
    driftSample: Math.max(1, int(env.KEEPER_DRIFT_SAMPLE, 20)),
    lowBalance: parseNear(env.KEEPER_LOW_BALANCE_NEAR || '0.5'),
    daos: list(env.KEEPER_DAOS, base.root === DEFAULT_ROOTS[base.network] && DEPLOYMENT_DAOS[base.network] ? [DEPLOYMENT_DAOS[base.network] as string] : []),
    daoRoles: list(env.KEEPER_DAO_ROLES, ['member', 'contributor']),
  };
}

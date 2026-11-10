/** Indexer settings from the environment; every value has a working public testnet default. */

import { existsSync, readFileSync } from 'node:fs';
import { contractIdsFor, resolveNetwork, type Network } from '@attestra/sdk';

/** The deployment's first block, from deployments/<network>.json when it is present. */
function deploymentHeight(network: string): number {
  const file = new URL(`../../../deployments/${network}.json`, import.meta.url);
  if (!existsSync(file)) return 0;
  try {
    return Number((JSON.parse(readFileSync(file, 'utf8')) as { start_height?: number }).start_height ?? 0);
  } catch {
    return 0;
  }
}

export interface IndexerConfig {
  network: Network;
  root: string;
  databaseUrl: string;
  txApiUrl: string;
  rpcUrl: string;
  port: number;
  /** First block to read when there is no cursor (the deployment height). */
  startHeight: number;
  pollMs: number;
  /** Stay this many blocks behind the API head so a transaction's receipts have executed. */
  lagBlocks: number;
  fastnearKey?: string;
  accounts: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const network = (env.NEAR_NETWORK ?? 'testnet') as Network;
  const net = resolveNetwork(network, { root: env.ATTESTRA_ROOT });
  const c = contractIdsFor(net.root);
  return {
    network,
    root: net.root,
    databaseUrl: env.DATABASE_URL ?? 'postgres://localhost:5432/attestra',
    txApiUrl: (env.TX_API_URL ?? net.txApiUrl).replace(/\/+$/, ''),
    rpcUrl: env.RPC_URL ?? net.rpcUrls[0],
    port: Number(env.PORT ?? 5100),
    // 0 or empty means "the deployment height": .env.example ships START_HEIGHT=0.
    startHeight: Number(env.START_HEIGHT) || deploymentHeight(network),
    pollMs: Number(env.POLL_MS ?? 4000),
    lagBlocks: Number(env.LAG_BLOCKS ?? 3),
    fastnearKey: env.FASTNEAR_API_KEY || undefined,
    accounts: [
      c.schemas,
      c.attestations,
      c.verdicts,
      c.credentials,
      c.staking,
      c.resolvers.whitelist,
      c.resolvers.fee,
      c.resolvers.tokenGated,
      c.resolvers.tokenReward,
      c.resolvers.pipeline,
    ],
  };
}

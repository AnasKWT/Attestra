/** Indexer settings from the environment; every value has a working public testnet default. */

import { contractIdsFor, resolveNetwork, type Network } from '@attestra/sdk';

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
    startHeight: Number(env.START_HEIGHT ?? 0),
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

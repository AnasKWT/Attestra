/** Starts the keeper: a pass every KEEPER_INTERVAL_MS, read-only (drift check only) without a key. */

import { IndexerClient } from '@attestra/sdk';
import { NearWriter, RpcReader } from '../lib/chain';
import { listen } from '../lib/http';
import { RecentErrors, logger } from '../lib/log';
import { createKeeperApp } from './app';
import { loadKeeperConfig } from './config';
import { Keeper } from './keeper';

export function startKeeper(env: NodeJS.ProcessEnv = process.env) {
  const config = loadKeeperConfig(env);
  const log = logger('keeper');
  const errors = new RecentErrors();
  const reader = new RpcReader(config);
  const writer = config.privateKey ? new NearWriter({ accountId: config.accountId, privateKey: config.privateKey, network: config.network, rpcUrl: config.rpcUrl }) : null;
  if (!writer) log(`${config.idleReason ?? 'idle'}: only the drift check runs`);
  const keeper = new Keeper({ config, indexer: new IndexerClient(config.indexerUrl), reader, writer, log, errors });
  const app = createKeeperApp({ config, keeper, reader, writer, errors });
  const server = listen(app, config.port, () => log(`listening on :${config.port} (${config.network}, ${config.accountId}, ${writer ? 'active' : 'read-only'}, every ${config.intervalMs} ms)`));

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const loop = async () => {
    await keeper.tick();
    if (!stopped) timer = setTimeout(loop, config.intervalMs);
  };
  timer = setTimeout(loop, 1000);
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await server.close();
    },
  };
}

/** Starts the top-up: a run every TOPUP_INTERVAL_MS from the treasury; without its key, plans only. */

import { join } from 'node:path';
import { NearWriter, RpcReader } from '../lib/chain';
import { listen } from '../lib/http';
import { DailyLedger } from '../lib/ledger';
import { RecentErrors, logger } from '../lib/log';
import { createTopUpApp } from './app';
import { loadTopUpConfig } from './config';
import { TopUp } from './topup';

export function startTopUp(env: NodeJS.ProcessEnv = process.env) {
  const config = loadTopUpConfig(env);
  const log = logger('topup');
  const errors = new RecentErrors();
  const reader = new RpcReader(config);
  const writer = config.privateKey ? new NearWriter({ accountId: config.accountId, privateKey: config.privateKey, network: config.network, rpcUrl: config.rpcUrl }) : null;
  if (!writer) log(`${config.idleReason ?? 'idle'}: balances are read and refills only planned`);
  const topup = new TopUp({ config, reader, writer, ledger: new DailyLedger(join(config.dataDir, 'topup-budget.json')), log, errors });
  const app = createTopUpApp({ config, topup, writer, errors });
  const server = listen(app, config.port, () => log(`listening on :${config.port} (${config.network}, treasury ${config.accountId}, ${writer ? 'active' : 'idle'}, every ${config.intervalMs} ms)`));

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const loop = async () => {
    await topup.run('interval');
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

/** Starts the relayer: idle (read-only) without a key, otherwise submitting through the send queue. */

import { join } from 'node:path';
import { NearWriter, RpcReader } from '../lib/chain';
import { listen } from '../lib/http';
import { DailyLedger } from '../lib/ledger';
import { RecentErrors, logger } from '../lib/log';
import { createRelayerApp } from './app';
import { loadRelayerConfig } from './config';
import { RelayerPolicy } from './policy';

export function startRelayer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadRelayerConfig(env);
  const log = logger('relayer');
  const reader = new RpcReader(config);
  const writer = config.privateKey
    ? new NearWriter({
        accountId: config.accountId,
        privateKey: config.privateKey,
        network: config.network,
        rpcUrl: config.rpcUrl,
        gasKey: config.gasKey,
        gasKeyLanes: config.gasKeyLanes,
      })
    : null;
  if (!writer) log(config.idleReason ?? 'idle');
  if (writer && config.gasKeyLanes > 0 && !config.gasKey) log('RELAYER_GAS_KEY_LANES is set but RELAYER_GAS_KEY is not: sending sequentially');
  const policy = new RelayerPolicy(config, new DailyLedger(join(config.dataDir, 'relayer-budgets.json')));
  const app = createRelayerApp({ config, reader, writer, policy, log, errors: new RecentErrors() });
  const server = listen(app, config.port, () =>
    log(`listening on :${config.port} (${config.network}, ${config.accountId}, ${writer ? `${writer.lanes} lane${writer.lanes > 1 ? 's' : ''}${writer.gasKey ? ' on a gas key' : ''}` : 'idle'})`),
  );
  return { stop: () => server.close() };
}

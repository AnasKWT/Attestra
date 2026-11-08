/**
 * Entry point: `tsx src/main.ts <relayer|keeper|topup>`. Each service answers `/live` and
 * `/health` and runs idle (read-only) when its key is missing.
 */

import { startKeeper } from './keeper/index';
import { startRelayer } from './relayer/index';
import { startTopUp } from './topup/index';

const services = { relayer: startRelayer, keeper: startKeeper, topup: startTopUp } as const;
const name = process.argv[2] as keyof typeof services | undefined;

if (!name || !(name in services)) {
  console.error(`usage: tsx src/main.ts <${Object.keys(services).join('|')}>`);
  process.exit(2);
}

const running = services[name]();
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await running.stop();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

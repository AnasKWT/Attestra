/**
 * Adds a gas key to the relayer account and funds it, so the relayer can send several
 * transactions in parallel (one per nonce lane) instead of one at a time.
 *
 * A gas key (NEAR protocol 2.13) is an access key with its own prepaid gas balance and `numNonces`
 * independent nonce slots. The key is added as `gasKeyFullAccess`: the relayer sends to several
 * receivers (the attestations and schemas contracts, and the senders of relayed meta
 * transactions), which a function-call gas key bound to one receiver could not do.
 *
 * Usage (from services/, with the relayer's full-access key in the environment):
 *
 *   RELAYER_PRIVATE_KEY=ed25519:... pnpm setup-gas-key --lanes 4 --fund 2
 *   pnpm setup-gas-key --dry-run          # prints the plan, sends nothing
 *
 * Options:
 *   --lanes N    nonce slots (parallel lanes), default RELAYER_GAS_KEY_LANES or 4
 *   --fund NEAR  NEAR moved from the relayer's balance into the gas key's balance, default 1
 *   --fund-only  only move --fund NEAR into the existing RELAYER_GAS_KEY (top it up later)
 *   --dry-run    print what would be sent and exit
 *
 * It reuses RELAYER_GAS_KEY when set; otherwise it generates a key and writes it to
 * `$DATA_DIR/relayer-gas-key.json` (mode 600). Then set RELAYER_GAS_KEY to that secret and
 * RELAYER_GAS_KEY_LANES to N, and restart the relayer. Gas spent by the key comes out of its own
 * balance, so watch it and top it up with --fund-only.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Near, generateKey, parseKey, type PrivateKey } from 'near-kit';
import { int } from '../src/lib/config';
import { txHashOf } from '../src/lib/outcome';
import { formatNear, parseNear } from '../src/lib/units';
import { loadRelayerConfig } from '../src/relayer/config';

// `pnpm setup-gas-key -- --dry-run` passes the `--` through; drop it so flags stay flags.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    lanes: { type: 'string' },
    fund: { type: 'string', default: '1' },
    'dry-run': { type: 'boolean', default: false },
    'fund-only': { type: 'boolean', default: false },
  },
});

const config = loadRelayerConfig();
const lanes = int(values.lanes, config.gasKeyLanes || 4);
if (lanes < 1 || lanes > 65535) throw new Error('--lanes must be between 1 and 65535');
const fund = parseNear(values.fund ?? '1');
if (values['fund-only'] && !config.gasKey) throw new Error('--fund-only needs RELAYER_GAS_KEY');

const key = config.gasKey ? parseKey(config.gasKey) : generateKey();
const publicKey = key.publicKey.toString();
const action = values['fund-only'] ? `fund gas key ${publicKey}` : `add gas key ${publicKey} (gasKeyFullAccess, ${lanes} lanes) and fund it`;
console.log(`${config.accountId} on ${config.network}: ${action} with ${formatNear(fund)} NEAR`);

if (values['dry-run']) {
  console.log('dry run: nothing sent');
  process.exit(0);
}
if (!config.privateKey) throw new Error(`RELAYER_PRIVATE_KEY is needed to sign for ${config.accountId}`);

let secretFile: string | null = null;
if (!config.gasKey) {
  // Save the secret before sending, so a key that lands on chain is never lost.
  mkdirSync(config.dataDir, { recursive: true });
  secretFile = join(config.dataDir, 'relayer-gas-key.json');
  writeFileSync(secretFile, JSON.stringify({ account_id: config.accountId, public_key: publicKey, private_key: key.secretKey, lanes }, null, 2), { mode: 0o600 });
}

const near = new Near({ network: config.network, rpcUrl: config.rpcUrl, privateKey: config.privateKey as PrivateKey, defaultSignerId: config.accountId });
let tx = near.transaction(config.accountId);
if (!values['fund-only']) tx = tx.addKey(publicKey, { type: 'gasKeyFullAccess', numNonces: lanes });
const outcome = await tx.transferToGasKey(publicKey, fund).send({ waitUntil: 'FINAL' });
console.log(`done: tx ${txHashOf(outcome)}`);
if (secretFile) {
  console.log(`the gas key secret is in ${secretFile}; set in the relayer's environment:`);
  console.log(`  RELAYER_GAS_KEY=<private_key from ${secretFile}>`);
  console.log(`  RELAYER_GAS_KEY_LANES=${lanes}`);
}

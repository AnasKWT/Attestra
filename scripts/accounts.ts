/**
 * Creates the service accounts under the deployment root and writes their .env lines:
 * treasury (funds the others through the top-up service), relayer, keeper and agent.
 * Idempotent: existing accounts are kept and their keys are read from the keychain.
 *
 *   pnpm accounts testnet                 keys in ~/.near-credentials/testnet/, env in internal/secrets/services.env
 *   HOLD_FILE=<file> pnpm accounts sandbox   against a node held by `HOLD=<file> pnpm deploy:sandbox`
 *   SCALE=0.5 pnpm accounts testnet          start every account (and the top-up thresholds) at half the plan
 *
 * #mainnet: refuses mainnet unless ATTESTRA_MAINNET_GO names the root, like the deploy script.
 * The env file holds private keys: it lives in gitignored internal/ and is never committed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryKeyStore, Near, generateKey } from 'near-kit';
import { FileKeyStore } from 'near-kit/keys/file';
import { DEFAULT_ROOTS, resolveNetwork } from '@attestra/sdk';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const NET = (process.argv[2] ?? 'testnet') as 'testnet' | 'mainnet' | 'sandbox';
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

// NEAR each account starts with. The treasury keeps the rest of a week's operation.
const PLAN = [
  { name: 'treasury', near: 10, env: 'TREASURY' },
  { name: 'relayer', near: 6, env: 'RELAYER' },
  { name: 'keeper', near: 2, env: 'KEEPER' },
  { name: 'agent', near: 4, env: 'AGENT' },
] as const;
const SCALE = Number(process.env.SCALE ?? 1);
const amount = (near: number) => Math.round(near * SCALE * 100) / 100;

async function main() {
  let near: Near;
  let root: string;
  let rpcUrl: string;
  const secrets = new Map<string, string>();
  let keyStore: FileKeyStore | InMemoryKeyStore;

  if (NET === 'sandbox') {
    const hold = process.env.HOLD_FILE;
    if (!hold || !existsSync(hold)) throw new Error('set HOLD_FILE to the file written by HOLD=<file> pnpm deploy:sandbox');
    const env = JSON.parse(readFileSync(hold, 'utf8')) as { rpcUrl: string; root: string; rootSecret: string };
    root = env.root;
    rpcUrl = env.rpcUrl;
    keyStore = new InMemoryKeyStore({ [root]: env.rootSecret });
    near = new Near({ network: { rpcUrl, networkId: 'sandbox' }, keyStore });
  } else {
    if (NET === 'mainnet' && process.env.ATTESTRA_MAINNET_GO !== (process.env.ROOT ?? DEFAULT_ROOTS.mainnet)) {
      throw new Error('#mainnet: refusing without ATTESTRA_MAINNET_GO set to the root account (the owner must approve)');
    }
    const net = resolveNetwork(NET, { root: process.env.ROOT });
    root = net.root;
    rpcUrl = process.env.RPC_URL ?? net.rpcUrls[0];
    keyStore = new FileKeyStore(join(homedir(), '.near-credentials'), NET);
    near = new Near({ network: NET, rpcUrl, keyStore });
  }

  const exists = async (id: string) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'optimistic', account_id: id } }),
    });
    return !((await res.json()) as { error?: unknown }).error;
  };

  // Keys written by an earlier run, for accounts whose key is not in the keychain (the sandbox's is in memory).
  const file = join(repo, 'internal/secrets', `services.${NET}.env`);
  const earlier = new Map(
    (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n').flatMap((l) => {
      const m = /^([A-Z]+)_PRIVATE_KEY=(.+)$/.exec(l);
      return m ? [[m[1], m[2]] as const] : [];
    }),
  );

  for (const a of PLAN) {
    const id = `${a.name}.${root}`;
    if (await exists(id)) {
      const secret = (await keyStore.get(id))?.secretKey ?? earlier.get(a.env);
      if (!secret) throw new Error(`${id} exists but its key is neither in the keychain nor in ${file}`);
      secrets.set(a.env, secret);
      log(`kept ${id}`);
      continue;
    }
    const key = generateKey();
    await keyStore.add(id, key);
    const out = await near.transaction(root).createAccount(id).transfer(id, `${amount(a.near)} NEAR`).addKey(key.publicKey.toString(), { type: 'fullAccess' }).send();
    secrets.set(a.env, key.secretKey);
    log(`created ${id} with ${amount(a.near)} NEAR (${(out as { transaction: { hash: string } }).transaction.hash})`);
  }

  const lines = [
    `# Service accounts under ${root} (${NET}), written by scripts/accounts.ts. Private keys: never commit.`,
    `NEAR_NETWORK=${NET === 'sandbox' ? 'testnet' : NET}`,
    `ATTESTRA_ROOT=${root}`,
    ...PLAN.flatMap((a) => [`${a.env}_ACCOUNT_ID=${a.name}.${root}`, `${a.env}_PRIVATE_KEY=${secrets.get(a.env)}`]),
    `TOPUP_ACCOUNTS=relayer.${root}:${amount(3)}:${amount(6)},keeper.${root}:${amount(1)}:${amount(2)},agent.${root}:${amount(2)}:${amount(4)}`,
  ];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  log(`wrote ${file}: copy the lines into the VM's .env`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

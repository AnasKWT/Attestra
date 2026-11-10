/**
 * Publishes the checker to NEAR OutLayer and reads its build-bound key, with the agent account:
 *
 *   1. uploads the reproducible wasm to FastFS (on-chain storage: one `__fastdata_fastfs` call per
 *      chunk to the OutLayer contract, sent with 1 gas so it reverts while its arguments stay on
 *      chain, which is what FastFS serves);
 *   2. stores NEARAI_API_KEY as the agent's OutLayer secret for this wasm hash, encrypted here to the
 *      keystore's X25519 key (ECIES: X25519, HKDF-SHA256 "outlayer-keystore-v1", ChaCha20-Poly1305)
 *      and readable only by the agent account;
 *   3. runs the published wasm once on chain (`request_execution` with a `WasmUrl` source) to read
 *      the checker's public key, the key OutLayer's keystore derives from the wasm hash.
 *
  *   pnpm outlayer:publish checker/target/outlayer/attestra-checker.wasm [--skip-upload] [--skip-secrets]
 *
 * Reads AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY and NEARAI_API_KEY from the environment and prints the
 * lines to put in the agent's .env and the key to allowlist with `set_enclave_keys`.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Near } from 'near-kit';
import { decodeReturnValue, OUTLAYER_GAS, OUTLAYER_LIMITS } from '../apps/agent/src/outlayer';

const NETWORK = (process.env.NEAR_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
const CONTRACT = NETWORK === 'mainnet' ? 'outlayer.near' : 'outlayer.testnet';
const API = NETWORK === 'mainnet' ? 'https://api.outlayer.ai' : 'https://testnet-api.outlayer.ai';
const FASTFS = NETWORK === 'mainnet' ? 'main.fastfs.io' : 'test.fastfs.io';
const CHUNK = 1 << 20;

const wasmPath = process.argv[2];
if (!wasmPath) throw new Error('usage: publish.ts <checker.wasm> [--skip-upload] [--skip-secrets]');
const account = process.env.AGENT_ACCOUNT_ID;
const key = process.env.AGENT_PRIVATE_KEY;
if (!account || !key) throw new Error('set AGENT_ACCOUNT_ID and AGENT_PRIVATE_KEY');
const near = new Near({ network: NETWORK, privateKey: key as `ed25519:${string}`, defaultSignerId: account });
const log = (m: string) => console.error(`${new Date().toISOString().slice(11, 19)} ${m}`);

// ─── Borsh, by hand: the FastFS payloads are small and fixed ───────────────────
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
const bytes = (b: Uint8Array) => Buffer.concat([u32(b.length), Buffer.from(b)]);

/** `FastfsData::Simple { relative_path, content: Some({ mime_type, content }) }`, or `Partial` chunks above 1 MB. */
function fastfsPayloads(path: string, mime: string, content: Uint8Array): Buffer[] {
  if (content.length <= CHUNK) return [Buffer.concat([Buffer.from([0]), str(path), Buffer.from([1]), str(mime), bytes(content)])];
  const nonce = Math.floor(Date.now() / 1000) - 1_769_376_240;
  const out: Buffer[] = [];
  for (let offset = 0; offset < content.length; offset += CHUNK) {
    const chunk = content.subarray(offset, Math.min(offset + CHUNK, content.length));
    out.push(Buffer.concat([Buffer.from([1]), str(path), u32(offset), u32(content.length), str(mime), bytes(chunk), u32(nonce)]));
  }
  return out;
}

/** ECIES to the keystore: `[0x01 | ephemeral X25519 public | nonce(12) | ciphertext+tag]`, base64. */
function encryptForKeystore(pubkeyHex: string, plaintext: string): string {
  const recipient = Buffer.from(pubkeyHex, 'hex');
  if (recipient.length !== 32) throw new Error('the keystore key must be 32 bytes of X25519');
  const eph = x25519.utils.randomSecretKey();
  const shared = x25519.getSharedSecret(eph, recipient);
  const symmetric = hkdf(sha256, shared, undefined, new TextEncoder().encode('outlayer-keystore-v1'), 32);
  const nonce = randomBytes(12);
  const sealed = chacha20poly1305(symmetric, nonce).encrypt(new TextEncoder().encode(plaintext));
  return Buffer.concat([Buffer.from([1]), Buffer.from(x25519.getPublicKey(eph)), nonce, Buffer.from(sealed)]).toString('base64');
}

async function main() {
  const wasm = readFileSync(wasmPath);
  const hash = createHash('sha256').update(wasm).digest('hex');
  const path = `${hash}.wasm`;
  const url = `https://${FASTFS}/${account}/${CONTRACT}/${path}`;
  log(`checker ${wasmPath}: ${wasm.length} bytes, sha256 ${hash}`);

  if (!process.argv.includes('--skip-upload')) {
    for (const [i, payload] of fastfsPayloads(path, 'application/wasm', wasm).entries()) {
      // 1 gas: the call reverts by design, and FastFS reads the file from its arguments.
      const tx = near.transaction(account!).functionCall(CONTRACT, '__fastdata_fastfs', payload, { gas: '1', attachedDeposit: '0 yocto' } as never);
      await tx.sign();
      const txHash = tx.getHash();
      await tx.send({ waitUntil: 'INCLUDED' }).catch((e: Error) => {
        if (!/exceeded|GasExceeded|NotEnoughGas|Exceeded the prepaid gas|ZodError/i.test(`${e.name} ${e.message}`)) throw e;
      });
      log(`uploaded chunk ${i + 1} (${txHash})`);
    }
    // FastFS indexes the receipt within seconds; wait until it serves the exact bytes.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url).catch(() => null);
      const body = res?.ok ? Buffer.from(await res.arrayBuffer()) : null;
      if (body && createHash('sha256').update(body).digest('hex') === hash) break;
      if (attempt > 30) throw new Error(`${url} does not serve the uploaded bytes yet`);
      await new Promise((r) => setTimeout(r, Math.min(2000 * (attempt + 1), 10_000)));
    }
    log(`FastFS serves it: ${url}`);
  }

  if (!process.argv.includes('--skip-secrets')) {
    const apiKey = process.env.NEARAI_API_KEY;
    if (!apiKey) throw new Error('set NEARAI_API_KEY');
    const secrets = JSON.stringify({ NEARAI_API_KEY: apiKey });
    const res = await fetch(`${API}/secrets/pubkey`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessor: { type: 'WasmHash', hash }, owner: account, profile: 'default', secrets_json: secrets }),
    });
    if (!res.ok) throw new Error(`the keystore answered ${res.status}: ${await res.text()}`);
    const { pubkey } = (await res.json()) as { pubkey: string };
    const encrypted = encryptForKeystore(pubkey, secrets);
    const out = await near.call(
      CONTRACT,
      'store_secrets',
      { accessor: { WasmHash: { hash } }, profile: 'default', encrypted_secrets_base64: encrypted, access: { Whitelist: { accounts: [account] } }, vault_id: null },
      { gas: '50 Tgas', attachedDeposit: '0.1 NEAR', waitUntil: 'EXECUTED_OPTIMISTIC' } as never,
    );
    decodeReturnValue(out);
    log('stored NEARAI_API_KEY as the agent account\'s secret for this wasm hash (readable by the agent account only)');
  }

  // The checker's key: one on-chain run of the published wasm. The run's transaction is kept, since
  // its OutLayer TEE attestation binds the key (the run's output) to the wasm hash.
  const input = JSON.stringify({ operation: 'public_key' });
  const args = { source: { WasmUrl: { url, hash, build_target: 'wasm32-wasip2' } }, resource_limits: { ...OUTLAYER_LIMITS }, input_data: input, secrets_ref: null, response_format: 'Json' };
  const cost = await near.view<string>(CONTRACT, 'estimate_execution_cost', { resource_limits: args.resource_limits, input_len: input.length });
  const tx = near.transaction(account!).functionCall(CONTRACT, 'request_execution', args, { gas: `${OUTLAYER_GAS / 10n ** 12n} Tgas`, attachedDeposit: `${cost} yocto` } as never);
  await tx.sign();
  const keyTx = tx.getHash()!;
  // The call yields until the worker answers, which outlasts the RPC's wait: send, then read the status by hash.
  await tx.send({ waitUntil: 'INCLUDED' }).catch((e: Error) => {
    if (e.name !== 'ZodError') throw e;
  });
  let value: { enclaveKey?: string } | null = null;
  for (let attempt = 0; attempt < 100 && !value; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await near.getTransactionStatus(keyTx, account!, 'NONE' as never).catch(() => null);
    const s = (status as { status?: unknown } | null)?.status;
    if (s && typeof s === 'object' && ('SuccessValue' in s || 'Failure' in s)) value = decodeReturnValue(status) as { enclaveKey?: string } | null;
  }
  if (!value?.enclaveKey) throw new Error(`the checker answered ${JSON.stringify(value)} (transaction ${keyTx})`);
  log(`the checker's key ${value.enclaveKey} (run ${keyTx})`);

  // Recorded beside the contracts, so pnpm verify can check the build, the TEE attestation and the allowlist.
  const recordFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'deployments', `${NETWORK}.json`);
  const record = JSON.parse(readFileSync(recordFile, 'utf8')) as Record<string, unknown>;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  record.checker = { wasm_hash: hash, wasm_url: url, key: value.enclaveKey, key_tx: keyTx, key_tx_signer: account, commit, build: 'checker/build.sh --reproducible' };
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  log(`recorded the checker in deployments/${NETWORK}.json`);
  console.log(`CHECKER_MODE=outlayer\nOUTLAYER_WASM_URL=${url}\nOUTLAYER_WASM_HASH=${hash}\nOUTLAYER_SECRETS_PROFILE=default\n# allowlist with set_enclave_keys:\nOUTLAYER_CHECKER_KEY=${value.enclaveKey}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

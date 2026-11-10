/**
 * Writes checker/tests/fixtures/ts.json: vectors computed by the TypeScript code the checker must
 * match (packages/sdk/src/e2ee.ts, packages/sdk/src/verdicts.ts, apps/agent/src/check.ts and
 * nearai.ts). The Rust tests read the file; regenerate it after changing either side:
 *
 *   apps/agent/node_modules/.bin/tsx checker/scripts/fixtures.ts
 */

import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptWithEd25519Seed, encryptForModel } from '../../packages/sdk/src/e2ee';
import { verdictDigest } from '../../packages/sdk/src/verdicts';
import { bytesToHex, hexToBytes } from '../../packages/sdk/src/borsh';
import { rulePrompt } from '../../apps/agent/src/check';
import { verifySignature } from '../../apps/agent/src/nearai';

const seedKey = (seed: Uint8Array) => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const publicHex = (seed: Uint8Array) => Buffer.from(createPublicKey(seedKey(seed)).export({ format: 'jwk' }).x!, 'base64url').toString('hex');
const ed25519Sign = (seed: Uint8Array, message: string) => bytesToHex(sign(null, Buffer.from(message), seedKey(seed)));

/** Runs `fn` with crypto.getRandomValues answering the given byte strings in order. */
function withRandom<T>(chunks: Uint8Array[], fn: () => T): T {
  const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  const queue = [...chunks];
  globalThis.crypto.getRandomValues = (<A extends ArrayBufferView>(b: A) => {
    const next = queue.shift();
    if (!next || next.length !== b.byteLength) throw new Error('fixture random queue mismatch');
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength).set(next);
    return b;
  }) as typeof globalThis.crypto.getRandomValues;
  try {
    return fn();
  } finally {
    globalThis.crypto.getRandomValues = original;
  }
}

const modelSeed = new Uint8Array(32).fill(7);
const modelPub = publicHex(modelSeed);
const clientSeed = Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 1);
const clientPub = publicHex(clientSeed);

const toModel = ['Date of birth: 1990-04-02', 'Unicode evidence: Zoë, 東京, emoji 🙂'].map((plaintext) => ({ plaintext, ciphertext: encryptForModel(plaintext, modelPub) }));
for (const c of toModel) if (decryptWithEd25519Seed(c.ciphertext, modelSeed) !== c.plaintext) throw new Error('TS round trip failed');

const eph = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const nonce = Uint8Array.from({ length: 24 }, (_, i) => i + 100);
const deterministic = { ephemeral: bytesToHex(eph), nonce: bytesToHex(nonce), plaintext: 'You are a strict verifier.', ciphertext: withRandom([eph, nonce], () => encryptForModel('You are a strict verifier.', modelPub)) };

const response = { plaintext: 'PASS', ciphertext: encryptForModel('PASS', clientPub) };

const text = `z-ai/glm-5.3-flash:${'ab'.repeat(32)}:${'cd'.repeat(32)}`;
const signature = { text, signature: ed25519Sign(modelSeed, text), key: modelPub };
if (!verifySignature({ ...signature, signing_algo: 'ed25519' }, { ed25519: modelPub })) throw new Error('TS rejects its own signature');

const verdict = {
  request_id: '1f'.repeat(32),
  rule_id: 'github_contributor',
  subject: 'eip155:1:0xabcdef0123456789abcdef0123456789abcdef01',
  result: false,
  evidence_hash: bytesToHex(hexToBytes('5a'.repeat(32))),
  model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
  issued_at: 1_790_000_000,
  expires_at: 1_790_000_000 + 365 * 86_400,
};

const rule = { id: 'age_over_18', claim: 'is at least 18 years old', enabled: true };

const out = {
  generated_by: 'checker/scripts/fixtures.ts',
  model_seed: bytesToHex(modelSeed),
  model_pub: modelPub,
  client_seed: bytesToHex(clientSeed),
  client_pub: clientPub,
  to_model: toModel,
  deterministic,
  response,
  signature,
  verdict: { verdict, digest: bytesToHex(verdictDigest(verdict)) },
  rule_prompt: { rule, prompt: rulePrompt(rule) },
  uri: ['type:pr author:octo-cat is:merged', 'Qwen/Qwen3.8-27B', "a!~*'()_.- é/?#&=+"].map((s) => ({ input: s, encoded: encodeURIComponent(s) })),
};

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'ts.json');
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${file}`);

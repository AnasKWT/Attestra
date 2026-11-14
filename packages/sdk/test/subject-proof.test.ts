import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { base58Encode, bytesToHex, evidenceSha256, githubOwnerAgrees, keySigner, nep413Hash, privateCheckMessage, signPrivateCheck, verifySubjectProof } from '../src';

const seed = new Uint8Array(32).fill(5);
const secret = `ed25519:${base58Encode(seed)}`;
const pub = `ed25519:${base58Encode(ed25519.getPublicKey(seed))}`;
const V = 'verdicts.attestra.testnet';
const NOW = 1_790_000_000;
const req = { ruleId: 'age_over_18', subject: 'bob.testnet', encryptedEvidence: 'beef', github: null, deadline: NOW + 600 };
const keys = (account: string, key: string) => Promise.resolve(account === 'bob.testnet' && key === pub);

describe('subject proof', () => {
  it('signs the exact message the checker verifies, and verifies it', async () => {
    const proof = await signPrivateCheck(keySigner(secret), req, V);
    expect(proof.message).toBe(privateCheckMessage(req));
    expect(JSON.parse(proof.message)).toEqual({ action: 'private_check', rule_id: 'age_over_18', subject: 'bob.testnet', evidence_sha256: evidenceSha256('beef'), github: null, deadline: NOW + 600 });
    expect(proof.public_key).toBe(pub);
    await verifySubjectProof({ proof, ...req, recipient: V, hasFullAccessKey: keys, now: NOW });
  });

  it('refuses a missing, foreign, stale or mismatched proof', async () => {
    const proof = await signPrivateCheck(keySigner(secret), req, V);
    const check = (o: Partial<Parameters<typeof verifySubjectProof>[0]>) => verifySubjectProof({ proof, ...req, recipient: V, hasFullAccessKey: keys, now: NOW, ...o });
    await expect(check({ proof: null })).rejects.toThrow(/must sign/);
    await expect(check({ subject: 'carol.testnet' })).rejects.toThrow(/another rule or subject/);
    await expect(check({ encryptedEvidence: 'cafe' })).rejects.toThrow(/other evidence/);
    await expect(check({ github: 'octo' })).rejects.toThrow(/GitHub login/);
    await expect(check({ now: NOW + 601 })).rejects.toThrow(/expired/);
    await expect(check({ recipient: 'verdicts.attestra.near' })).rejects.toThrow(/does not verify/);
    await expect(check({ hasFullAccessKey: () => Promise.resolve(false) })).rejects.toThrow(/not a full-access key/);
    await expect(check({ subject: 'eip155:1:0xabc' })).rejects.toThrow(/NEAR account/);
    const long = await signPrivateCheck(keySigner(secret), { ...req, deadline: NOW + 2 * 86_400 }, V);
    await expect(check({ proof: long })).rejects.toThrow(/more than a day/);
  });

  it('lets an implicit account prove with the key it is made of, without a lookup', async () => {
    const implicit = bytesToHex(ed25519.getPublicKey(seed));
    const r = { ...req, subject: implicit };
    const proof = await signPrivateCheck(keySigner(secret), r, V);
    await verifySubjectProof({ proof, ...r, recipient: V, hasFullAccessKey: () => Promise.reject(new Error('no lookup')), now: NOW });
    const other = await signPrivateCheck(keySigner(`ed25519:${base58Encode(new Uint8Array(32).fill(6))}`), r, V);
    await expect(verifySubjectProof({ proof: other, ...r, recipient: V, hasFullAccessKey: keys, now: NOW })).rejects.toThrow(/implicit account/);
  });

  it('matches the checker on the NEP-413 hash (a vector the Rust tests check too)', () => {
    expect(bytesToHex(nep413Hash('{"action":"private_check"}', new Uint8Array(32).fill(0x5a), V))).toBe('bc4a661274abe9eb4c9df6fc9bf5911fb5e638d602c137285393247c0058900c');
  });

  it('finds the gist in which a GitHub login names the subject', async () => {
    const f = (async (url: string) => {
      if (url.includes('/gists')) return Response.json([{ files: { 'attestra.txt': { raw_url: 'https://gist.githubusercontent.com/octo/1/raw/attestra.txt' } } }, { files: { 'attestra.txt': { raw_url: 'https://evil.example/attestra.txt' } } }]);
      return new Response('hello\nattestra:bob.testnet\n');
    }) as unknown as typeof fetch;
    await githubOwnerAgrees('octo', 'bob.testnet', { fetch: f });
    await expect(githubOwnerAgrees('octo', 'carol.testnet', { fetch: f })).rejects.toThrow(/no public gist/);
  });
});

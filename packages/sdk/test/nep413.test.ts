import { describe, expect, it } from 'vitest';
import { generateKey, verifyNep413Signature } from 'near-kit';
import { buildMessage, keySigner, nep413Hash, signRequest, verifyRequest } from '../src/nep413';
import { base64ToBytes, bytesToHex } from '../src/borsh';

describe('NEP-413 delegated requests', () => {
  it('builds a stable message', () => {
    const m = buildMessage({ action: 'attest', attester: 'a.testnet', schema_uid: 'aa'.repeat(32), subject: 'b.testnet', data: 'AQID', deadline: 10 });
    expect(m).toBe(`{"action":"attest","attester":"a.testnet","schema_uid":"${'aa'.repeat(32)}","subject":"b.testnet","data":"AQID","deadline":10}`);
    expect(buildMessage({ action: 'revoke', attester: 'a.testnet', uid: 'bb'.repeat(32), deadline: 5 })).toContain('"action":"revoke"');
  });

  it('hash matches near-kit and signatures verify', async () => {
    const key = generateKey();
    const signer = keySigner(key.secretKey);
    expect(signer.publicKey).toBe(key.publicKey.toString());
    const req = await signRequest(signer, { action: 'revoke', attester: 'a.testnet', uid: 'bb'.repeat(32), deadline: 5 }, 'attestations.attestra.testnet');
    expect(verifyRequest(req, 'attestations.attestra.testnet')).toBe(true);
    expect(verifyRequest(req, 'other.testnet')).toBe(false);
    expect(verifyRequest({ ...req, message: req.message.replace('5', '6') }, 'attestations.attestra.testnet')).toBe(false);
    const ok = await verifyNep413Signature(
      { accountId: 'a.testnet', publicKey: req.public_key, signature: req.signature },
      { message: req.message, recipient: 'attestations.attestra.testnet', nonce: base64ToBytes(req.nonce) },
      { maxAge: Infinity },
    );
    expect(ok).toBe(true);
  });

  it('hash is 32 bytes and depends on every field', () => {
    const n = new Uint8Array(32);
    const h = bytesToHex(nep413Hash('m', n, 'r'));
    expect(h).toHaveLength(64);
    expect(bytesToHex(nep413Hash('m', n, 'r2'))).not.toBe(h);
    expect(bytesToHex(nep413Hash('m', n, 'r', 'https://x'))).not.toBe(h);
  });
});

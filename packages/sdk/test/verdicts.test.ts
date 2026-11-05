import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/borsh';
import { verdictDigest, walletCaip10 } from '../src/verdicts';

describe('verdicts', () => {
  it('digest matches the contract vector (contracts/verdicts/src/tests.rs)', () => {
    const d = verdictDigest({
      request_id: '0a'.repeat(32),
      rule_id: 'age_over_18',
      subject: 'alice.testnet',
      result: true,
      evidence_hash: '0e'.repeat(32),
      model: 'Qwen/Qwen3.5-122B-A10B',
      issued_at: 1699999970,
      expires_at: 1700086400,
    });
    expect(bytesToHex(d)).toBe('5bbe4290afcb5f87dfc7112c0e23723ad1795147d001fa3c60e17df80c59a26e');
  });

  it('builds wallet CAIP-10 ids', () => {
    expect(walletCaip10('eip155', '0xAbCd')).toBe('eip155:1:0xabcd');
    expect(walletCaip10('solana', 'So1')).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:So1');
  });
});

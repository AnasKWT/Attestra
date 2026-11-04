import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { computeAttestationUid, computeSchemaUid, isUid, normalizeUid } from '../src/uid';

// The same vectors are pinned in contracts/common/src/uid.rs.
const SCHEMA_VECTOR = 'b7707f26a2b3f1bd97ad1c8919f9c78e47031eb71092bdc441ed441110b8f452';
const ATTESTATION_VECTOR = '25619991e2f806fb62df932cd5c230a6595655c085a9a09716cc5e8702f63ede';

describe('UIDs match the contracts byte for byte', () => {
  it('schema vector', () => {
    expect(computeSchemaUid('string name, u8 level', null, true)).toBe(SCHEMA_VECTOR);
  });

  it('attestation vector', () => {
    expect(computeAttestationUid(SCHEMA_VECTOR, 'bob.testnet', 'alice.testnet', new Uint8Array([1, 2, 3]), 0)).toBe(ATTESTATION_VECTOR);
    expect(computeAttestationUid(SCHEMA_VECTOR, 'bob.testnet', 'alice.testnet', '010203', 0)).toBe(ATTESTATION_VECTOR);
  });

  it('every input changes the UID', () => {
    const base = computeSchemaUid('string name', null, true);
    expect(computeSchemaUid('string name', null, false)).not.toBe(base);
    expect(computeSchemaUid('string name', 'whitelist.attestra.testnet', true)).not.toBe(base);
    expect(computeSchemaUid('string nam', null, true)).not.toBe(base);
  });

  it('is deterministic and well formed (property)', () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), fc.option(fc.constantFrom('a.testnet', 'resolver.near'), { nil: null }), (def, rev, res) => {
        const a = computeSchemaUid(def, res, rev);
        expect(a).toBe(computeSchemaUid(def, res, rev));
        expect(isUid(a)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), (data, nonce) => {
        const u = computeAttestationUid(SCHEMA_VECTOR, 'bob.testnet', 'alice.testnet', data, nonce);
        expect(u).toMatch(/^[0-9a-f]{64}$/);
      }),
    );
  });

  it('normalizes', () => {
    expect(normalizeUid(`0x${SCHEMA_VECTOR.toUpperCase()}`)).toBe(SCHEMA_VECTOR);
    expect(() => normalizeUid('abc')).toThrow();
  });
});

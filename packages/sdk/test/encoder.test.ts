import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { SchemaEncoder, parseSchema } from '../src/encoder';
import { bytesToHex } from '../src/borsh';

describe('SchemaEncoder', () => {
  const enc = new SchemaEncoder('string name, u8 level, bool verified, account_id issuer, u64 since, i32 delta, bytes32 doc, string[] tags, u128 amount');
  const values = {
    name: 'Bob',
    level: 3,
    verified: true,
    issuer: 'acme.testnet',
    since: '1700000000',
    delta: -5,
    doc: 'ab'.repeat(32),
    tags: ['kyc', 'eu'],
    amount: '340282366920938463463374607431768211455',
  };

  it('round-trips', () => {
    expect(enc.decode(enc.encode(values))).toEqual(values);
  });

  it('produces canonical Borsh bytes', () => {
    const e = new SchemaEncoder('string name, u8 level, bool ok');
    expect(bytesToHex(e.encodeBytes({ name: 'Bo', level: 7, ok: true }))).toBe('02000000426f' + '07' + '01');
  });

  it('rejects bad values and definitions', () => {
    expect(() => enc.encode({ ...values, level: 300 })).toThrow();
    expect(() => enc.encode({ ...values, issuer: 'Not Valid' })).toThrow();
    expect(() => enc.encode({ ...values, doc: 'ab' })).toThrow();
    expect(() => enc.encode({ name: 'x' })).toThrow(/missing field/);
    expect(enc.validate(values)).toBe(true);
    expect(enc.validate({})).toBe(false);
    expect(() => parseSchema('uint256 x')).toThrow(/unknown type/);
    expect(() => parseSchema('string a, string a')).toThrow(/duplicate/);
    expect(() => parseSchema('')).toThrow();
    expect(() => enc.decode(new Uint8Array([1, 2]))).toThrow();
  });

  it('defaults encode and JSON schema lists every field', () => {
    // An account id has no sensible default; every other type does.
    expect(enc.validate({ ...enc.generateDefaults(), issuer: 'acme.testnet' })).toBe(true);
    const js = enc.toJSONSchema() as { required: string[] };
    expect(js.required).toHaveLength(9);
  });

  it('round-trips random values (property)', () => {
    const e = new SchemaEncoder('string s, u32 n, i64 m, bool b, bytes raw, u16[] list');
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
        fc.boolean(),
        fc.uint8Array({ maxLength: 40 }),
        fc.array(fc.integer({ min: 0, max: 65535 }), { maxLength: 10 }),
        (s, n, m, b, raw, list) => {
          const v = { s, n, m: m.toString(), b, raw: bytesToHex(raw), list };
          expect(e.decode(e.encodeBytes(v))).toEqual(v);
        },
      ),
    );
  });
});

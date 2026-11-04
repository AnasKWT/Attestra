import { describe, expect, it } from 'vitest';
import { classifyError, errorMessage } from '../src/errors';
import { AttestraErrorType } from '../src/types';

describe('error mapping', () => {
  const cases: Array<[string, AttestraErrorType]> = [
    ['Smart contract panicked: schema abc already exists', AttestraErrorType.ALREADY_EXISTS],
    ['Smart contract panicked: already revoked', AttestraErrorType.ALREADY_REVOKED],
    ['Smart contract panicked: attestation not found', AttestraErrorType.NOT_FOUND],
    ['Smart contract panicked: only the attester can revoke', AttestraErrorType.UNAUTHORIZED],
    ['Smart contract panicked: not a delegate of this authority', AttestraErrorType.UNAUTHORIZED],
    ['Smart contract panicked: the delegation expired', AttestraErrorType.EXPIRED],
    ['Smart contract panicked: storage balance too low: need 5 yoctoNEAR, have 1', AttestraErrorType.INSUFFICIENT_STORAGE],
    ["the schema's resolver refused attestation x; rejected", AttestraErrorType.RESOLVER_REJECTED],
    ['Smart contract panicked: the schema is not revocable', AttestraErrorType.VALIDATION_ERROR],
    ['fetch failed', AttestraErrorType.NETWORK_ERROR],
    ['something odd', AttestraErrorType.UNKNOWN_ERROR],
  ];
  it.each(cases)('%s', (msg, type) => {
    expect(classifyError(new Error(msg))).toBe(type);
  });

  it('extracts contract panic messages', () => {
    expect(errorMessage(new Error('Smart contract panicked: only governance can verify authorities\nmore'))).toBe('only governance can verify authorities');
    expect(errorMessage({ panic: 'invalid signature' })).toBe('invalid signature');
    expect(errorMessage('plain')).toBe('plain');
  });
});

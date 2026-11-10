import { describe, expect, it } from 'vitest';
import { classifyError, errorMessage, fail } from '../src/errors';
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
    ['{"ActionError":{"kind":{"AddKeyAlreadyExists":{}}}}', AttestraErrorType.ALREADY_EXISTS],
    ['{"ActionError":{"kind":{"DeleteKeyDoesNotExist":{}}}}', AttestraErrorType.NOT_FOUND],
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

  it('maps the SDK flags for configuration and validation errors', () => {
    expect(fail(Object.assign(new Error('no signer'), { config: true })).error?.type).toBe(AttestraErrorType.CONFIGURATION_ERROR);
    expect(fail(Object.assign(new Error('above the limit'), { validation: true })).error?.type).toBe(AttestraErrorType.VALIDATION_ERROR);
    expect(fail(Object.assign(new Error('above the limit'), { validation: true }), AttestraErrorType.UNAUTHORIZED).error?.type).toBe(AttestraErrorType.UNAUTHORIZED);
  });
});

describe('transaction and rate-limit errors', () => {
  it('reads a rate limit as a network error, not a validation error', () => {
    expect(classifyError(new Error('HTTP 429: Too Many Requests'))).toBe(AttestraErrorType.NETWORK_ERROR);
    expect(classifyError(new Error('Smart contract panicked: too many fields'))).toBe(AttestraErrorType.VALIDATION_ERROR);
  });

  it('turns an RPC NotEnoughBalance into a sentence with the amounts', () => {
    const e = Object.assign(new Error('Server error'), {
      name: 'TransactionError',
      data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: { signer_id: 'abc.testnet', balance: '69000000000000000000000', cost: '100900000000000000000000' } } } },
    });
    expect(errorMessage(e)).toBe('NotEnoughBalance: abc.testnet has 0.069 NEAR free but the transaction needs 0.1009 NEAR (attached deposit plus prepaid gas)');
    expect(classifyError(e)).toBe(AttestraErrorType.INSUFFICIENT_STORAGE);
  });
});

describe('bad input', () => {
  it('reports a malformed UID as a validation error', async () => {
    const { AttestraClient } = await import('../src/client');
    const r = await new AttestraClient({ network: 'testnet' }).isValid('zz');
    expect(r.error?.type).toBe(AttestraErrorType.VALIDATION_ERROR);
    expect(r.error?.message).toContain('expected 64 hex characters');
  });
});

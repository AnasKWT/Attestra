import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { extractEvents, parseEventLog, refreshTargets } from '../src/events';
import { clampPage, statusOf } from '../src/api';
import type { TxRecord } from '../src/txapi';

const log = (event: string, data: object, standard = 'attestra') => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data: [data] })}`;

function tx(logs: string[], executor = 'attestations.attestra.testnet'): TxRecord {
  const o = (id: string, l: string[], ex: string) => ({ id, block_height: 100, block_timestamp: '1700000000000000000', index: 0, outcome: { executor_id: ex, logs: l, status: {}, receipt_ids: [] } });
  return {
    transaction: { hash: 'TX', signer_id: 'alice.testnet', receiver_id: executor },
    execution_outcome: o('TXO', [], 'alice.testnet'),
    receipts: [{ receipt: { receipt_id: 'R1', receiver_id: executor, predecessor_id: 'alice.testnet' }, execution_outcome: o('R1', logs, executor) }],
  };
}

describe('event parsing', () => {
  it('parses NEP-297 lines and ignores others', () => {
    expect(parseEventLog(log('attestation_created', { uid: 'ab' }))?.event).toBe('attestation_created');
    expect(parseEventLog('hello')).toBeNull();
    expect(parseEventLog('EVENT_JSON:{bad')).toBeNull();
    expect(parseEventLog('EVENT_JSON:{"event":"x"}')).toBeNull();
  });

  it('never throws on arbitrary log lines (property)', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(() => parseEventLog(s)).not.toThrow();
      expect(() => parseEventLog(`EVENT_JSON:${s}`)).not.toThrow();
    }));
  });

  it('extracts events only from our contracts, with uid and accounts', () => {
    const rows = extractEvents(
      tx([log('attestation_created', { uid: 'u1', attester: 'alice.testnet', subject: 'bob.testnet', actor: 'alice.testnet' }), 'plain text', log('nft_mint', { owner_id: 'bob.testnet' }, 'nep171')]),
      new Set(['attestations.attestra.testnet']),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ uid: 'u1', event: 'attestation_created', tx_hash: 'TX', receipt_id: 'R1', log_index: 0, block_timestamp: 1700000000000 });
    expect(rows[0].accounts.sort()).toEqual(['alice.testnet', 'bob.testnet']);
    expect(extractEvents(tx([log('attestation_created', { uid: 'u1' })], 'other.testnet'), new Set(['attestations.attestra.testnet']))).toHaveLength(0);
  });

  it('maps events to the records to refresh', () => {
    const base = { receipt_id: 'r', log_index: 0, tx_hash: 't', signer_id: 's', contract: 'c', standard: 'attestra', uid: null, accounts: [], block_height: 1, block_timestamp: 1 };
    expect(refreshTargets({ ...base, event: 'schema_registered', data: { uid: 'x' } })).toEqual({ schema: 'x' });
    expect(refreshTargets({ ...base, event: 'attestation_revoked', data: { uid: 'y' } })).toEqual({ attestation: 'y' });
    expect(refreshTargets({ ...base, event: 'delegate_added', data: { authority: 'a' } })).toEqual({ delegatesOf: 'a', authority: 'a' });
    expect(refreshTargets({ ...base, event: 'multisig_created', data: { id: 'ms-1.x' } })).toEqual({ authority: 'ms-1.x' });
    expect(refreshTargets({ ...base, event: 'fee_charged', data: {} })).toEqual({});
  });
});

describe('status and paging', () => {
  it('computes status like the contract', () => {
    expect(statusOf({ state: 'pending', revoked: false, revoke_at: 0, expiration_time: 0 }, 10)).toBe('pending');
    expect(statusOf({ state: 'active', revoked: true, revoke_at: 0, expiration_time: 0 }, 10)).toBe('revoked');
    expect(statusOf({ state: 'active', revoked: false, revoke_at: 10, expiration_time: 0 }, 10)).toBe('revoked');
    expect(statusOf({ state: 'active', revoked: false, revoke_at: 11, expiration_time: 0 }, 10)).toBe('active');
    expect(statusOf({ state: 'active', revoked: false, revoke_at: 0, expiration_time: 10 }, 10)).toBe('active');
    expect(statusOf({ state: 'active', revoked: false, revoke_at: 0, expiration_time: 9 }, 10)).toBe('expired');
    expect(statusOf({ state: 'revoking', revoked: false, revoke_at: 0, expiration_time: 0 }, 10)).toBe('revoking');
  });

  it('clamps pages (property)', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (l, o) => {
      const p = clampPage(l, o);
      expect(p.limit).toBeGreaterThanOrEqual(1);
      expect(p.limit).toBeLessThanOrEqual(100);
      expect(p.offset).toBeGreaterThanOrEqual(0);
    }));
    expect(clampPage(undefined, undefined)).toEqual({ limit: 20, offset: 0 });
    expect(clampPage('500', '-3')).toEqual({ limit: 100, offset: 0 });
  });
});

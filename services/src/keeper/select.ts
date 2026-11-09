/**
 * Which attestations the keeper acts on, and how the indexer's copy is compared with the chain.
 * Pure functions over indexer rows, so the rules are tested without a network.
 */

import type { AttestationRecord, IndexedAttestation } from '@attestra/sdk';

/** Scheduled revocations whose time has passed but whose `attestation_revoked` event never landed. */
export function dueRevocations(rows: IndexedAttestation[], nowSecs: number, skip: (uid: string) => boolean = () => false): string[] {
  return rows.filter((a) => a.revoke_at > 0 && a.revoke_at <= nowSecs && a.revoke_tx_hash == null && !skip(a.uid)).map((a) => a.uid);
}

/** Expired attestations not yet known to be recorded (the events API settles the rest). */
export function expiredCandidates(rows: IndexedAttestation[], nowSecs: number, skip: (uid: string) => boolean = () => false): string[] {
  return rows.filter((a) => a.expiration_time > 0 && a.expiration_time < nowSecs && !a.revoked && !skip(a.uid)).map((a) => a.uid);
}

/** Panics that mean the work was already done, so the uid counts as handled. */
export function alreadyDone(kind: 'finalize' | 'expiry', message: string): boolean {
  return kind === 'finalize' ? /already revoked/i.test(message) : /expiry already recorded/i.test(message);
}

/** Panics that mean "not yet" (clock skew between the indexer and the chain): try again later. */
export function notYet(message: string): boolean {
  return /no revocation is due|has not expired/i.test(message);
}

export interface Drift {
  uid: string;
  field: 'exists' | 'status' | 'revoked' | 'revoke_at';
  indexer: unknown;
  chain: unknown;
}

/**
 * Differences between the indexer's row and the chain's record. Status and revoked are skipped
 * while a revocation or expiry time is within `graceSecs` of now (the two clocks differ a little).
 */
export function compareRecord(indexed: IndexedAttestation, chain: AttestationRecord | null, nowSecs: number, graceSecs = 60): Drift[] {
  if (!chain) return [{ uid: indexed.uid, field: 'exists', indexer: true, chain: false }];
  const out: Drift[] = [];
  if (indexed.revoke_at !== chain.revoke_at) out.push({ uid: indexed.uid, field: 'revoke_at', indexer: indexed.revoke_at, chain: chain.revoke_at });
  const near = (t: number) => t > 0 && Math.abs(nowSecs - t) <= graceSecs;
  if (near(chain.revoke_at) || near(chain.expiration_time)) return out;
  if (indexed.status !== chain.status) out.push({ uid: indexed.uid, field: 'status', indexer: indexed.status, chain: chain.status });
  if (indexed.revoked !== chain.revoked) out.push({ uid: indexed.uid, field: 'revoked', indexer: indexed.revoked, chain: chain.revoked });
  return out;
}

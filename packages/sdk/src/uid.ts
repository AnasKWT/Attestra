/**
 * Off-chain UID computation, byte for byte the same as the contracts
 * (`contracts/common/src/uid.rs`):
 *
 *   schema UID      = sha256(borsh(("attestra:schema:v1", definition, resolver: Option<AccountId>, revocable)))
 *   attestation UID = sha256(borsh(("attestra:attestation:v1", schema_uid: [u8; 32], subject, attester, data: Vec<u8>, nonce: u64)))
 *
 * UIDs are 64 lowercase hex characters without a prefix.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { BorshWriter, bytesToHex, hexToBytes } from './borsh';

export const SCHEMA_TAG = 'attestra:schema:v1';
export const ATTESTATION_TAG = 'attestra:attestation:v1';

export function computeSchemaUid(definition: string, resolver: string | null | undefined, revocable: boolean): string {
  const w = new BorshWriter()
    .string(SCHEMA_TAG)
    .string(definition)
    .option(resolver || null, (w, r) => w.string(r))
    .bool(revocable);
  return bytesToHex(sha256(w.toBytes()));
}

export function computeAttestationUid(
  schemaUid: string,
  subject: string,
  attester: string,
  data: Uint8Array | string,
  nonce: number | bigint,
): string {
  const bytes = typeof data === 'string' ? hexToBytes(data) : data;
  const w = new BorshWriter()
    .string(ATTESTATION_TAG)
    .fixed(uidBytes(schemaUid))
    .string(subject)
    .string(attester)
    .bytes(bytes)
    .u64(nonce);
  return bytesToHex(sha256(w.toBytes()));
}

export function uidBytes(uid: string): Uint8Array {
  const b = hexToBytes(uid);
  if (b.length !== 32) throw new Error(`a UID is 32 bytes (64 hex characters), got ${b.length}`);
  return b;
}

export function isUid(value: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(value);
}

/** Normalizes a UID to 64 lowercase hex characters. */
export function normalizeUid(value: string): string {
  if (!isUid(value)) throw new Error(`not a UID: ${value}`);
  return value.replace(/^0x/, '').toLowerCase();
}

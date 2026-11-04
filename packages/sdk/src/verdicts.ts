/**
 * Shapes and digests of the verdicts contract (contracts/verdicts):
 * - AI verdicts signed by the private-check enclave,
 * - foreign-chain events verified by the NEAR MPC network,
 * - wallet links proven by the foreign wallet's own signature.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { BorshWriter } from './borsh';
import { uidBytes } from './uid';

export interface AiVerdict {
  request_id: string;
  rule_id: string;
  subject: string;
  result: boolean;
  /** SHA-256 (hex) of the exact NEAR AI request body; the evidence itself is never stored. */
  evidence_hash: string;
  model: string;
  issued_at: number;
  expires_at: number;
}

/** sha256(borsh(("attestra:verdict:v1", request_id, rule_id, subject, result, evidence_hash, model, issued_at, expires_at))) */
export function verdictDigest(v: AiVerdict): Uint8Array {
  const w = new BorshWriter()
    .string('attestra:verdict:v1')
    .fixed(uidBytes(v.request_id))
    .string(v.rule_id)
    .string(v.subject)
    .bool(v.result)
    .fixed(uidBytes(v.evidence_hash))
    .string(v.model)
    .u64(v.issued_at)
    .u64(v.expires_at);
  return sha256(w.toBytes());
}

/** EVM chain ids the verdicts contract maps foreign events to (CAIP-2 `eip155:<id>`). */
export const foreignChainIds: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  bnb: 56,
  avalanche: 43114,
};

export const SOLANA_MAINNET_REF = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** The CAIP-10 id the contract records for a linked wallet. */
export function walletCaip10(chain: 'eip155' | 'solana', address: string): string {
  return chain === 'eip155' ? `eip155:1:${address.toLowerCase()}` : `solana:${SOLANA_MAINNET_REF}:${address}`;
}

/**
 * Well-known schemas the Attestra deployment registers. Their UIDs are deterministic, so the SDK
 * computes them from the definitions instead of hardcoding them.
 */

import { computeSchemaUid } from './uid';

export interface KnownSchema {
  key: string;
  name: string;
  definition: string;
  revocable: boolean;
  description: string;
}

export const KNOWN_SCHEMAS = {
  agentIdentity: {
    key: 'agentIdentity',
    name: 'Agent identity',
    definition: 'string name, account_id owner, string model, string[] capabilities, string endpoint, string description',
    revocable: true,
    description: 'An AI agent: who owns it, which model it runs, what it can do and where to reach it. Issued by the owner about the agent account.',
  },
  agentReview: {
    key: 'agentReview',
    name: 'Agent review',
    definition: 'u8 score, string comment, string job_ref',
    revocable: true,
    description: 'A rating from 1 to 5 by someone (a person or an agent) who hired the agent, about the agent account.',
  },
  aiCheck: {
    key: 'aiCheck',
    name: 'Private AI check',
    definition: 'string rule_id, string claim, bool result, bytes32 evidence_hash, string model, bytes32 request_id, u64 checked_at',
    revocable: true,
    description: 'A fact checked privately by a verifiable model inside an enclave; only the hash of the evidence is stored.',
  },
  foreignEvent: {
    key: 'foreignEvent',
    name: 'Cross-chain event',
    definition: 'string chain, bytes32 tx_id, u64 block_number, bytes emitter, bytes32[] topics, bytes data, u64 log_index',
    revocable: false,
    description: 'An event on another chain, verified by the NEAR MPC network through Chain Signatures.',
  },
  walletLink: {
    key: 'walletLink',
    name: 'Wallet link',
    definition: 'string chain, string address, string caip10',
    revocable: true,
    description: 'A wallet on another chain proven (by its own signature) to belong to a NEAR account.',
  },
  membership: {
    key: 'membership',
    name: 'Membership',
    definition: 'string organization, string role, u64 since',
    revocable: true,
    description: 'A person or account belongs to an organization in a role; useful for reputation-gated access.',
  },
} as const satisfies Record<string, KnownSchema>;

export type KnownSchemaKey = keyof typeof KNOWN_SCHEMAS;

export function knownSchemaUid(key: KnownSchemaKey): string {
  const s = KNOWN_SCHEMAS[key];
  return computeSchemaUid(s.definition, null, s.revocable);
}

/** Every well-known schema with its UID. */
export function knownSchemas(): Array<KnownSchema & { uid: string }> {
  return Object.values(KNOWN_SCHEMAS).map((s) => ({ ...s, uid: computeSchemaUid(s.definition, null, s.revocable) }));
}

/**
 * Types shared by the SDK: the response wrapper every method returns instead of throwing, error categories, and the JSON shapes
 * the Attestra contracts and indexer return.
 */

export enum AttestraErrorType {
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  NOT_FOUND = 'NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  ALREADY_REVOKED = 'ALREADY_REVOKED',
  RESOLVER_REJECTED = 'RESOLVER_REJECTED',
  EXPIRED = 'EXPIRED',
  INSUFFICIENT_STORAGE = 'INSUFFICIENT_STORAGE',
  NETWORK_ERROR = 'NETWORK_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  TRANSACTION_ERROR = 'TRANSACTION_ERROR',
  PAYMENT_REQUIRED = 'PAYMENT_REQUIRED',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/** Every SDK method returns this and never throws. */
export interface ServiceResponse<T> {
  success: boolean;
  data?: T;
  error?: { type: AttestraErrorType; message: string };
  /** Hash of the transaction that produced the result, when there was one. */
  txHash?: string;
}

export type Network = 'testnet' | 'mainnet';

export interface SchemaFieldDefinition {
  type: string;
  name: string;
}

// ─── contract views ──────────────────────────────────────────────────────────

export type SchemaStatus = 'pending' | 'active';

export interface SchemaRecord {
  uid: string;
  definition: string;
  authority: string;
  resolver: string | null;
  revocable: boolean;
  /** Unix seconds. */
  created_at: number;
  status: SchemaStatus;
  /** Set when the definition is stored as a blob (large schemas). */
  blob_hash: string | null;
}

export type AttestationStatus = 'pending' | 'active' | 'revoking' | 'revoked' | 'expired';

export interface AttestationRecord {
  uid: string;
  schema_uid: string;
  attester: string;
  /** A NEAR account id or a CAIP-10 account id on another chain. */
  subject: string;
  /** Borsh bytes as base64; decode with `SchemaEncoder`. */
  data: string;
  created_at: number;
  /** 0 when it never expires. */
  expiration_time: number;
  revoked: boolean;
  revocation_time: number;
  /** Scheduled revocation time, 0 when none. */
  revoke_at: number;
  nonce: number;
  ref_uid: string | null;
  status: AttestationStatus;
}

export interface AuthorityRecord {
  account_id: string;
  metadata: string;
  kind: string;
  verified: boolean;
  registered_at: number;
  verified_at: number;
  tier: string | null;
  staked: string;
  delegate_count: number;
}

export interface DelegateScope {
  /** Schema UIDs the delegate may use; omit for any schema. */
  schemas?: string[];
  /** Unix seconds; omit for no expiry. */
  expiresAt?: number;
  /** Omit for unlimited. */
  maxUses?: number;
  canRevoke?: boolean;
  label?: string;
}

export interface DelegateRecord {
  authority: string;
  delegate: string;
  schemas: string[] | null;
  expires_at: number;
  max_uses: number;
  uses: number;
  can_revoke: boolean;
  label: string;
  granted_at: number;
  active: boolean;
}

/** `created`, `rejected` (resolver refused, record removed), `revoked`, `scheduled`, `refused` (revocation refused), `not_attested`, `failed`. */
export interface Outcome {
  uid: string;
  status: string;
}

export interface MultisigRecord {
  id: string;
  members: string[];
  threshold: number;
  metadata: string;
  created_by: string;
  created_at: number;
}

export type MultisigAction =
  | { type: 'attest'; schema_uid: string; subject: string; data: string; expiration_time?: number | null; ref_uid?: string | null }
  | { type: 'revoke'; uid: string };

export interface ProposalRecord {
  id: number;
  multisig: string;
  action: MultisigAction;
  proposer: string;
  approvals: string[];
  status: 'open' | 'executed' | 'cancelled';
  created_at: number;
}

export interface StorageBalance {
  total: string;
  available: string;
}

export interface StakeInfo {
  staked: string;
  tier: string | null;
}

export interface TierThreshold {
  name: string;
  min: string;
}

export interface CredentialToken {
  token_id: string;
  owner_id: string;
  metadata?: {
    title?: string | null;
    description?: string | null;
    issued_at?: string | null;
    expires_at?: string | null;
    extra?: string | null;
  } | null;
}

// ─── params ──────────────────────────────────────────────────────────────────

export interface RegisterSchemaParams {
  definition: string;
  resolver?: string | null;
  revocable: boolean;
  /** Attached deposit in yoctoNEAR (defaults to enough for the schema). */
  deposit?: string;
}

export interface CreateAttestationParams {
  schemaUid: string;
  subject: string;
  /** Base64 Borsh bytes (from `SchemaEncoder.encode`) or raw bytes. */
  data: string | Uint8Array;
  /** Unix seconds; omit or 0 for none. */
  expirationTime?: number;
  refUid?: string;
  deposit?: string;
}

export interface AttestOnBehalfParams extends CreateAttestationParams {
  authority: string;
}

// ─── indexer ─────────────────────────────────────────────────────────────────

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
}

export interface Paginated<T> {
  data: T[];
  pagination: Pagination;
}

export interface IndexedSchema extends SchemaRecord {
  attestation_count: number;
  tx_hash: string | null;
  block_height: number | null;
}

export interface IndexedAttestation extends AttestationRecord {
  tx_hash: string | null;
  block_height: number | null;
  revoke_tx_hash: string | null;
}

export interface IndexedAuthority extends AuthorityRecord {
  schema_count: number;
  attestation_count: number;
  tx_hash: string | null;
}

export interface IndexedEvent {
  id: number;
  event: string;
  contract: string;
  data: Record<string, unknown>;
  uid: string | null;
  accounts: string[];
  standard: string;
  log_index: number;
  tx_hash: string;
  receipt_id: string;
  block_height: number;
  block_timestamp: number;
  signer_id: string;
}

export interface ProfileSummary {
  account_id: string;
  authority: AuthorityRecord | null;
  schemas: IndexedSchema[];
  issued: IndexedAttestation[];
  received: IndexedAttestation[];
}

/**
 * AttestraClient: every Attestra operation on NEAR, returning `ServiceResponse<T>` and never
 * throwing.
 *
 *   const client = new AttestraClient({ network: 'testnet', accountId: 'alice.testnet', privateKey: 'ed25519:...' });
 *   const { data } = await client.registerSchema({ definition: 'string name, u8 level', revocable: true });
 *   await client.createAttestation({ schemaUid: data!.schemaUid, subject: 'bob.testnet', data: encoder.encode({ name: 'Bob', level: 3 }) });
 *
 * Reads work with no key. Writes need a signer: a private key, a near-kit `Near` with a wallet
 * (NEAR Connect via `fromHotConnect`), or a key store.
 */

import { Near } from 'near-kit';
import { bytesToBase64 } from './borsh';
import { NEAR_AI_VERIFY_URL, resolveNetwork, type NetworkConfig } from './config';
import { attempt, fail, ok } from './errors';
import { IndexerClient, type AgentProfile } from './indexer-client';
import { findEventReceipt, proveReceipt, type ProofResult } from './lightclient';
import { signRequest, type MessageSigner, type SignedRequest } from './nep413';
import { KNOWN_SCHEMAS, knownSchemaUid } from './schemas';
import { SchemaEncoder } from './encoder';
import { computeAttestationUid, computeSchemaUid, normalizeUid } from './uid';
import { payingFetch, type SettlementResponse } from './x402';
import {
  AttestraErrorType,
  type AttestationRecord,
  type AttestOnBehalfParams,
  type AuthorityRecord,
  type CreateAttestationParams,
  type CredentialToken,
  type DelegateRecord,
  type DelegateScope,
  type MultisigAction,
  type MultisigRecord,
  type Network,
  type Outcome,
  type ProposalRecord,
  type RegisterSchemaParams,
  type SchemaRecord,
  type ServiceResponse,
  type StakeInfo,
  type StorageBalance,
  type TierThreshold,
} from './types';

export interface AttestraClientConfig {
  network?: Network;
  /** Deployment root (defaults to attestra.testnet / attestra.near). */
  root?: string;
  rpcUrl?: string;
  /** Signer account. */
  accountId?: string;
  /** `ed25519:...` secret key for `accountId`. */
  privateKey?: string;
  /** A ready near-kit instance (for example with a NEAR Connect wallet). Takes precedence. */
  near?: Near;
  /** Indexer REST base URL, for lists, profiles and search. */
  indexerUrl?: string;
  /** Relayer base URL, for gasless submissions. */
  relayerUrl?: string;
  /** Attestra agent base URL, for private checks and paid verification. */
  agentUrl?: string;
  /** Extra headers for every RPC request (for example an RPC API key). */
  rpcHeaders?: Record<string, string>;
}

const TGAS = 1_000_000_000_000n;
const MILLINEAR = 10n ** 21n;
const DEFAULT_GAS = 300n * TGAS;
/** Deposit attached to a write when the signer's storage balance is low. */
const TOP_UP = 50n * MILLINEAR;
const LOW_WATER = 20n * MILLINEAR;

interface CallResult<T> {
  value: T;
  txHash: string;
}

function toBase64Data(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : bytesToBase64(data);
}

function decodeSuccessValue(outcome: unknown): unknown {
  const status = (outcome as { status?: { SuccessValue?: string; Failure?: unknown } })?.status;
  if (status && typeof status === 'object' && 'Failure' in status && status.Failure) {
    throw Object.assign(new Error(JSON.stringify(status.Failure)), { name: 'TransactionError' });
  }
  const v = status?.SuccessValue;
  if (!v) return undefined;
  const text = typeof Buffer !== 'undefined' ? Buffer.from(v, 'base64').toString('utf8') : atob(v);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function txHashOf(outcome: unknown): string {
  return (outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } })?.transaction?.hash
    ?? (outcome as { transaction_outcome?: { id?: string } })?.transaction_outcome?.id
    ?? '';
}

export class AttestraClient {
  readonly config: NetworkConfig;
  readonly near: Near;
  readonly accountId?: string;
  readonly indexer?: IndexerClient;
  private readonly relayerUrl?: string;
  private readonly agentUrl?: string;
  private readonly rpcHeaders?: Record<string, string>;
  private rpcId = 0;

  constructor(cfg: AttestraClientConfig = {}) {
    this.config = resolveNetwork(cfg.network ?? 'testnet', { root: cfg.root, rpcUrl: cfg.rpcUrl });
    this.accountId = cfg.accountId;
    this.rpcHeaders = cfg.rpcHeaders;
    this.near =
      cfg.near ??
      new Near({
        network: this.config.network,
        rpcUrl: this.config.rpcUrls[0],
        headers: cfg.rpcHeaders,
        ...(cfg.privateKey && cfg.accountId ? { privateKey: cfg.privateKey as `ed25519:${string}`, defaultSignerId: cfg.accountId } : {}),
        ...(cfg.accountId && !cfg.privateKey ? { defaultSignerId: cfg.accountId } : {}),
        retryConfig: { maxRetries: 2, initialDelayMs: 400 },
      });
    this.indexer = cfg.indexerUrl ? new IndexerClient(cfg.indexerUrl) : undefined;
    this.relayerUrl = cfg.relayerUrl?.replace(/\/+$/, '');
    this.agentUrl = cfg.agentUrl?.replace(/\/+$/, '');
  }

  get network(): Network {
    return this.config.network;
  }

  get contracts() {
    return this.config.contracts;
  }

  // ──────────────────────────────────────────────────────────── plumbing

  /** Raw JSON-RPC with failover across the configured endpoints. */
  async rpc<T>(method: string, params: unknown): Promise<T> {
    let last: unknown;
    for (const url of this.config.rpcUrls) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.rpcHeaders ?? {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`RPC ${url} answered ${res.status}`);
        const json = (await res.json()) as { result?: T; error?: { message?: string; data?: unknown; cause?: { name?: string } } };
        if (json.error) {
          const name = json.error.cause?.name ?? '';
          if (name === 'TOO_MANY_REQUESTS' || name === 'TIMEOUT_ERROR') throw new Error(`RPC ${url}: ${name}`);
          throw Object.assign(new Error(`${json.error.message ?? 'RPC error'}: ${JSON.stringify(json.error.data ?? json.error.cause)}`), { rpc: true });
        }
        return json.result as T;
      } catch (e) {
        if ((e as { rpc?: boolean }).rpc) throw e;
        last = e;
      }
    }
    throw last ?? new Error('no RPC endpoint answered');
  }

  async view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
    const res = await this.rpc<{ result: number[] }>('query', {
      request_type: 'call_function',
      finality: 'optimistic',
      account_id: contractId,
      method_name: method,
      args_base64: bytesToBase64(new TextEncoder().encode(JSON.stringify(args))),
    });
    const text = new TextDecoder().decode(Uint8Array.from(res.result));
    return (text ? JSON.parse(text) : null) as T;
  }

  private signer(): string {
    if (!this.accountId) throw Object.assign(new Error('no signer: set accountId (and privateKey or a wallet)'), { config: true });
    return this.accountId;
  }

  async callRaw<T>(contractId: string, method: string, args: object, opts: { deposit?: bigint | string; gas?: bigint } = {}): Promise<CallResult<T>> {
    const signerId = this.signer();
    const deposit = opts.deposit === undefined ? 0n : BigInt(opts.deposit);
    const outcome = await this.near.call(contractId, method, args, {
      signerId,
      gas: `${(opts.gas ?? DEFAULT_GAS) / TGAS} Tgas`,
      attachedDeposit: `${deposit} yocto`,
      waitUntil: 'EXECUTED_OPTIMISTIC',
    } as never);
    return { value: decodeSuccessValue(outcome) as T, txHash: txHashOf(outcome) };
  }

  /** Runs a write and wraps it; configuration problems become CONFIGURATION_ERROR. */
  private async write<T>(fn: () => Promise<{ data: T; txHash: string }>): Promise<ServiceResponse<T>> {
    try {
      const { data, txHash } = await fn();
      return ok(data, txHash);
    } catch (e) {
      if ((e as { config?: boolean }).config) return fail(e, AttestraErrorType.CONFIGURATION_ERROR);
      return fail(e);
    }
  }

  /** Deposit to attach so the signer's storage balance on `contractId` stays above the low-water mark. */
  private async storageTopUp(contractId: string, account: string): Promise<bigint> {
    try {
      const b = await this.view<StorageBalance | null>(contractId, 'storage_balance_of', { account_id: account });
      if (b && BigInt(b.available) >= LOW_WATER) return 0n;
    } catch {
      // unreadable balance: attach the top-up
    }
    return TOP_UP;
  }

  // ──────────────────────────────────────────────────────────── schemas

  static computeSchemaUid = computeSchemaUid;
  static computeAttestationUid = computeAttestationUid;

  async registerSchema(p: RegisterSchemaParams): Promise<ServiceResponse<{ schemaUid: string }>> {
    return this.write(async () => {
      const deposit = p.deposit ?? (await this.storageTopUp(this.contracts.schemas, this.signer())) + 3n * MILLINEAR;
      const r = await this.callRaw<string | null>(
        this.contracts.schemas,
        'register_schema',
        { definition: p.definition, resolver: p.resolver || null, revocable: p.revocable },
        { deposit },
      );
      if (!r.value) throw Object.assign(new Error('the resolver refused the schema'), {});
      return { data: { schemaUid: r.value }, txHash: r.txHash };
    });
  }

  async getSchema(uid: string): Promise<ServiceResponse<SchemaRecord>> {
    return attempt(async () => {
      const s = await this.view<SchemaRecord | null>(this.contracts.schemas, 'get_schema', { uid: normalizeUid(uid) });
      return s ?? fail<SchemaRecord>(new Error(`schema ${uid} not found`), AttestraErrorType.NOT_FOUND);
    });
  }

  /** Stores a large definition on chain (NEP-145 storage) and returns its hash. */
  async storeSchemaBlob(definition: string): Promise<ServiceResponse<{ blobHash: string; bytes: number }>> {
    return this.write(async () => {
      const bytes = new TextEncoder().encode(definition).length;
      const deposit = (BigInt(bytes) + 200n) * 10n ** 19n + (await this.storageTopUp(this.contracts.schemas, this.signer()));
      const r = await this.callRaw<string>(this.contracts.schemas, 'store_blob', { content: definition }, { deposit });
      return { data: { blobHash: r.value, bytes }, txHash: r.txHash };
    });
  }

  async getSchemaBlob(hash: string): Promise<ServiceResponse<{ blobHash: string; definition: string }>> {
    return attempt(async () => {
      const d = await this.view<string | null>(this.contracts.schemas, 'get_blob', { hash: normalizeUid(hash) });
      return d === null ? fail(new Error('blob not found'), AttestraErrorType.NOT_FOUND) : { blobHash: hash, definition: d };
    });
  }

  async registerSchemaFromBlob(p: { blobHash: string; resolver?: string | null; revocable: boolean }): Promise<ServiceResponse<{ schemaUid: string }>> {
    return this.write(async () => {
      const deposit = (await this.storageTopUp(this.contracts.schemas, this.signer())) + 3n * MILLINEAR;
      const r = await this.callRaw<string | null>(
        this.contracts.schemas,
        'register_schema_from_blob',
        { blob_hash: normalizeUid(p.blobHash), resolver: p.resolver || null, revocable: p.revocable },
        { deposit },
      );
      if (!r.value) throw new Error('the resolver refused the schema');
      return { data: { schemaUid: r.value }, txHash: r.txHash };
    });
  }

  async listSchemas(q: { authority?: string; limit?: number; offset?: number } = {}) {
    return attempt(async () => {
      if (this.indexer) return this.indexer.listSchemas(q);
      const data = await this.view<SchemaRecord[]>(this.contracts.schemas, 'list_schemas', { from_index: q.offset ?? 0, limit: q.limit ?? 20 });
      const total = await this.view<number>(this.contracts.schemas, 'schema_count');
      const filtered = q.authority ? data.filter((s) => s.authority === q.authority) : data;
      return { data: filtered, pagination: { total, limit: q.limit ?? 20, offset: q.offset ?? 0 } };
    });
  }

  // ──────────────────────────────────────────────────────────── attestations

  async createAttestation(p: CreateAttestationParams): Promise<ServiceResponse<{ attestationUid: string; status: string }>> {
    return this.write(async () => {
      const deposit = p.deposit ?? (await this.storageTopUp(this.contracts.attestations, this.signer()));
      const r = await this.callRaw<Outcome>(
        this.contracts.attestations,
        'attest',
        {
          schema_uid: normalizeUid(p.schemaUid),
          subject: p.subject,
          data: toBase64Data(p.data),
          expiration_time: p.expirationTime || null,
          ref_uid: p.refUid ? normalizeUid(p.refUid) : null,
        },
        { deposit },
      );
      if (r.value?.status === 'rejected') throw new Error(`the schema's resolver refused attestation ${r.value.uid}; rejected`);
      return { data: { attestationUid: r.value.uid, status: r.value.status }, txHash: r.txHash };
    });
  }

  async getAttestation(uid: string): Promise<ServiceResponse<AttestationRecord>> {
    return attempt(async () => {
      const a = await this.view<AttestationRecord | null>(this.contracts.attestations, 'get_attestation', { uid: normalizeUid(uid) });
      return a ?? fail<AttestationRecord>(new Error(`attestation ${uid} not found`), AttestraErrorType.NOT_FOUND);
    });
  }

  /** True when the attestation exists and is active now (not pending, revoked or expired). */
  async isValid(uid: string): Promise<ServiceResponse<{ valid: boolean }>> {
    return attempt(async () => ({ valid: await this.view<boolean>(this.contracts.attestations, 'is_valid', { uid: normalizeUid(uid) }) }));
  }

  async revokeAttestation(uid: string): Promise<ServiceResponse<{ status: string }>> {
    return this.write(async () => {
      const r = await this.callRaw<Outcome>(this.contracts.attestations, 'revoke', { uid: normalizeUid(uid) });
      if (r.value?.status === 'refused') throw new Error("the schema's resolver refused the revocation");
      return { data: { status: r.value.status }, txHash: r.txHash };
    });
  }

  async listAttestations(q: { schemaUid?: string; attester?: string; subject?: string; status?: string; limit?: number; offset?: number } = {}) {
    return attempt(async () => {
      if (!this.indexer) throw Object.assign(new Error('listing needs indexerUrl'), {});
      return this.indexer.listAttestations({ schema: q.schemaUid, attester: q.attester, subject: q.subject, status: q.status, limit: q.limit, offset: q.offset });
    });
  }

  async getNonce(accountId: string): Promise<ServiceResponse<{ nonce: number }>> {
    return attempt(async () => ({ nonce: await this.view<number>(this.contracts.attestations, 'get_nonce', { account_id: accountId }) }));
  }

  // ──────────────────────────────────────────────────────────── authorities

  async registerAuthority(metadata: string, kind?: string): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const deposit = await this.storageTopUp(this.contracts.attestations, this.signer());
      const r = await this.callRaw<void>(this.contracts.attestations, 'register_authority', { metadata, kind: kind ?? null }, { deposit });
      return { data: undefined, txHash: r.txHash };
    });
  }

  async getAuthority(accountId: string): Promise<ServiceResponse<AuthorityRecord>> {
    return attempt(async () => {
      const a = await this.view<AuthorityRecord | null>(this.contracts.attestations, 'get_authority', { account_id: accountId });
      return a ?? fail<AuthorityRecord>(new Error(`authority ${accountId} not found`), AttestraErrorType.NOT_FOUND);
    });
  }

  /** Governance only (the attestations contract's governance account, which can be a DAO). */
  async setAuthorityVerification(accountId: string, verified: boolean): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const r = await this.callRaw<void>(this.contracts.attestations, 'set_authority_verification', { account_id: accountId, verified });
      return { data: undefined, txHash: r.txHash };
    });
  }

  async getProfile(accountId: string) {
    return attempt(async () => {
      if (!this.indexer) throw new Error('profiles need indexerUrl');
      return this.indexer.getProfile(accountId);
    });
  }

  // ──────────────────────────────────────────────────────────── delegation

  async addDelegate(delegate: string, scope: DelegateScope = {}): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const deposit = await this.storageTopUp(this.contracts.attestations, this.signer());
      const r = await this.callRaw<void>(
        this.contracts.attestations,
        'add_delegate',
        {
          delegate,
          scope: {
            schemas: scope.schemas?.map(normalizeUid) ?? null,
            expires_at: scope.expiresAt ?? null,
            max_uses: scope.maxUses ?? null,
            can_revoke: scope.canRevoke ?? null,
            label: scope.label ?? null,
          },
        },
        { deposit },
      );
      return { data: undefined, txHash: r.txHash };
    });
  }

  async removeDelegate(delegate: string): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const r = await this.callRaw<void>(this.contracts.attestations, 'remove_delegate', { delegate });
      return { data: undefined, txHash: r.txHash };
    });
  }

  async isDelegate(authority: string, delegate: string): Promise<ServiceResponse<{ isDelegate: boolean }>> {
    return attempt(async () => ({ isDelegate: await this.view<boolean>(this.contracts.attestations, 'is_delegate', { authority, delegate }) }));
  }

  async getDelegates(authority: string): Promise<ServiceResponse<{ delegates: DelegateRecord[] }>> {
    return attempt(async () => ({ delegates: await this.view<DelegateRecord[]>(this.contracts.attestations, 'get_delegates', { authority }) }));
  }

  async attestOnBehalf(p: AttestOnBehalfParams): Promise<ServiceResponse<{ attestationUid: string; status: string }>> {
    return this.write(async () => {
      const r = await this.callRaw<Outcome>(
        this.contracts.attestations,
        'attest_on_behalf',
        {
          authority: p.authority,
          schema_uid: normalizeUid(p.schemaUid),
          subject: p.subject,
          data: toBase64Data(p.data),
          expiration_time: p.expirationTime || null,
          ref_uid: p.refUid ? normalizeUid(p.refUid) : null,
        },
        { deposit: p.deposit ?? 0n },
      );
      if (r.value?.status === 'rejected') throw new Error(`the schema's resolver refused attestation ${r.value.uid}; rejected`);
      return { data: { attestationUid: r.value.uid, status: r.value.status }, txHash: r.txHash };
    });
  }

  async revokeOnBehalf(uid: string): Promise<ServiceResponse<{ status: string }>> {
    return this.write(async () => {
      const r = await this.callRaw<Outcome>(this.contracts.attestations, 'revoke_on_behalf', { uid: normalizeUid(uid) });
      return { data: { status: r.value.status }, txHash: r.txHash };
    });
  }

  /** Registers an ed25519 key that may sign delegated (NEP-413) requests for the signer. */
  async addSignerKey(publicKey: string): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const deposit = await this.storageTopUp(this.contracts.attestations, this.signer());
      const r = await this.callRaw<void>(this.contracts.attestations, 'add_signer_key', { public_key: publicKey }, { deposit });
      return { data: undefined, txHash: r.txHash };
    });
  }

  async removeSignerKey(publicKey: string): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const r = await this.callRaw<void>(this.contracts.attestations, 'remove_signer_key', { public_key: publicKey });
      return { data: undefined, txHash: r.txHash };
    });
  }

  async getSignerKeys(accountId: string): Promise<ServiceResponse<{ keys: string[] }>> {
    return attempt(async () => ({ keys: await this.view<string[]>(this.contracts.attestations, 'get_signer_keys', { account_id: accountId }) }));
  }

  /** The attester signs an attestation request off chain; anyone can submit it. */
  async signDelegatedAttestation(
    p: CreateAttestationParams & { attester: string; deadline?: number },
    signer: MessageSigner,
  ): Promise<ServiceResponse<SignedRequest>> {
    return attempt(() =>
      signRequest(
        signer,
        {
          action: 'attest',
          attester: p.attester,
          schema_uid: normalizeUid(p.schemaUid),
          subject: p.subject,
          data: toBase64Data(p.data),
          expiration_time: p.expirationTime || null,
          ref_uid: p.refUid ? normalizeUid(p.refUid) : null,
          deadline: p.deadline ?? Math.floor(Date.now() / 1000) + 600,
        },
        this.contracts.attestations,
      ),
    );
  }

  async signDelegatedRevocation(p: { attester: string; uid: string; deadline?: number }, signer: MessageSigner): Promise<ServiceResponse<SignedRequest>> {
    return attempt(() =>
      signRequest(
        signer,
        { action: 'revoke', attester: p.attester, uid: normalizeUid(p.uid), deadline: p.deadline ?? Math.floor(Date.now() / 1000) + 600 },
        this.contracts.attestations,
      ),
    );
  }

  /** Submits a signed request from this client's account (it pays the gas). */
  async submitSigned(request: SignedRequest): Promise<ServiceResponse<Outcome>> {
    return this.write(async () => {
      const r = await this.callRaw<Outcome>(this.contracts.attestations, 'submit_signed', { request });
      return { data: r.value, txHash: r.txHash };
    });
  }

  /** Hands a signed request to the relayer, which submits it and pays the gas. */
  async relaySigned(request: SignedRequest): Promise<ServiceResponse<Outcome>> {
    return attempt(async () => {
      if (!this.relayerUrl) throw new Error('relaying needs relayerUrl');
      const res = await fetch(`${this.relayerUrl}/v1/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request }),
      });
      const body = (await res.json()) as { outcome?: Outcome; tx_hash?: string; error?: string };
      if (!res.ok || !body.outcome) throw new Error(body.error ?? `relayer answered ${res.status}`);
      return ok(body.outcome, body.tx_hash);
    });
  }

  // ──────────────────────────────────────────────────────────── storage (NEP-145)

  async storageDeposit(contract: 'schemas' | 'attestations', amountYocto: string, accountId?: string): Promise<ServiceResponse<StorageBalance>> {
    return this.write(async () => {
      const r = await this.callRaw<StorageBalance>(this.contracts[contract], 'storage_deposit', { account_id: accountId ?? null, registration_only: null }, {
        deposit: amountYocto,
      });
      return { data: r.value, txHash: r.txHash };
    });
  }

  async storageBalance(contract: 'schemas' | 'attestations', accountId: string): Promise<ServiceResponse<StorageBalance | null>> {
    return attempt(async () => this.view<StorageBalance | null>(this.contracts[contract], 'storage_balance_of', { account_id: accountId }));
  }

  async storageWithdraw(contract: 'schemas' | 'attestations', amountYocto?: string): Promise<ServiceResponse<StorageBalance>> {
    return this.write(async () => {
      const r = await this.callRaw<StorageBalance>(this.contracts[contract], 'storage_withdraw', { amount: amountYocto ?? null }, { deposit: 1n });
      return { data: r.value, txHash: r.txHash };
    });
  }

  // ──────────────────────────────────────────────────────────── scheduled revocation

  async scheduleRevocation(uid: string, revokeAt: number): Promise<ServiceResponse<{ status: string; revokeAt: number }>> {
    return this.write(async () => {
      const r = await this.callRaw<Outcome>(this.contracts.attestations, 'schedule_revocation', { uid: normalizeUid(uid), revoke_at: revokeAt });
      if (r.value?.status === 'refused') throw new Error("the schema's resolver refused the scheduled revocation");
      return { data: { status: r.value.status, revokeAt }, txHash: r.txHash };
    });
  }

  async getScheduledRevocation(uid: string): Promise<ServiceResponse<{ revokeAt: number; due: boolean; status: string }>> {
    return attempt(async () => {
      const a = await this.view<AttestationRecord | null>(this.contracts.attestations, 'get_attestation', { uid: normalizeUid(uid) });
      if (!a) return fail(new Error('attestation not found'), AttestraErrorType.NOT_FOUND);
      const now = Math.floor(Date.now() / 1000);
      return { revokeAt: a.revoke_at, due: a.revoke_at !== 0 && now >= a.revoke_at, status: a.status };
    });
  }

  /** Anyone can record a due scheduled revocation (the keeper does it automatically). */
  async finalizeRevocation(uid: string): Promise<ServiceResponse<Outcome>> {
    return this.write(async () => {
      const r = await this.callRaw<Outcome>(this.contracts.attestations, 'finalize_revocation', { uid: normalizeUid(uid) });
      return { data: r.value, txHash: r.txHash };
    });
  }

  // ──────────────────────────────────────────────────────────── multisig authorities

  async createMultisigAuthority(p: { members: string[]; threshold: number; metadata: string }): Promise<ServiceResponse<{ multisigId: string }>> {
    return this.write(async () => {
      const deposit = await this.storageTopUp(this.contracts.attestations, this.signer());
      const r = await this.callRaw<string>(this.contracts.attestations, 'create_multisig', p, { deposit });
      return { data: { multisigId: r.value }, txHash: r.txHash };
    });
  }

  async proposeMultisig(multisigId: string, action: MultisigAction): Promise<ServiceResponse<{ proposalId: number }>> {
    return this.write(async () => {
      const deposit = await this.storageTopUp(this.contracts.attestations, this.signer());
      const r = await this.callRaw<number>(this.contracts.attestations, 'propose', { multisig_id: multisigId, action }, { deposit });
      return { data: { proposalId: r.value }, txHash: r.txHash };
    });
  }

  /** Approves; returns the outcome when this approval reached the threshold, else null. */
  async approveMultisig(proposalId: number): Promise<ServiceResponse<Outcome | null>> {
    return this.write(async () => {
      const r = await this.callRaw<Outcome | null>(this.contracts.attestations, 'approve', { proposal_id: proposalId });
      return { data: r.value ?? null, txHash: r.txHash };
    });
  }

  async executeMultisig(proposalId: number): Promise<ServiceResponse<Outcome | null>> {
    return this.write(async () => {
      const r = await this.callRaw<Outcome | null>(this.contracts.attestations, 'execute_proposal', { proposal_id: proposalId });
      return { data: r.value ?? null, txHash: r.txHash };
    });
  }

  async cancelMultisig(proposalId: number): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const r = await this.callRaw<void>(this.contracts.attestations, 'cancel_proposal', { proposal_id: proposalId });
      return { data: undefined, txHash: r.txHash };
    });
  }

  async getMultisig(id: string): Promise<ServiceResponse<MultisigRecord>> {
    return attempt(async () => {
      const m = await this.view<MultisigRecord | null>(this.contracts.attestations, 'get_multisig', { id });
      return m ?? fail<MultisigRecord>(new Error('multisig not found'), AttestraErrorType.NOT_FOUND);
    });
  }

  async getProposal(id: number): Promise<ServiceResponse<ProposalRecord>> {
    return attempt(async () => {
      const p = await this.view<ProposalRecord | null>(this.contracts.attestations, 'get_proposal', { id });
      return p ?? fail<ProposalRecord>(new Error('proposal not found'), AttestraErrorType.NOT_FOUND);
    });
  }

  // ──────────────────────────────────────────────────────────── resolvers

  async resolverInfo(resolver: string) {
    return attempt(() => this.view<Record<string, unknown>>(resolver, 'resolver_info'));
  }

  async schemaAdmin(resolver: string, schemaUid: string): Promise<ServiceResponse<{ admin: string | null }>> {
    return attempt(async () => ({ admin: await this.view<string | null>(resolver, 'schema_admin', { schema_uid: normalizeUid(schemaUid) }) }));
  }

  private async adminCall(resolver: string, method: string, args: object, deposit = 2n * MILLINEAR): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const r = await this.callRaw<void>(resolver, method, args, { deposit });
      return { data: undefined, txHash: r.txHash };
    });
  }

  whitelistAdd(schemaUid: string, accountId: string) {
    return this.adminCall(this.contracts.resolvers.whitelist, 'whitelist_add', { schema_uid: normalizeUid(schemaUid), account_id: accountId });
  }

  whitelistRemove(schemaUid: string, accountId: string) {
    return this.adminCall(this.contracts.resolvers.whitelist, 'whitelist_remove', { schema_uid: normalizeUid(schemaUid), account_id: accountId }, 0n);
  }

  async whitelistCheck(schemaUid: string, accountId: string): Promise<ServiceResponse<{ whitelisted: boolean }>> {
    return attempt(async () => ({
      whitelisted: await this.view<boolean>(this.contracts.resolvers.whitelist, 'is_whitelisted', { schema_uid: normalizeUid(schemaUid), account_id: accountId }),
    }));
  }

  /** Sets a schema's fee; `token` omitted means NEAR. Amount in the smallest unit. */
  feeSetFee(schemaUid: string, amount: string, token?: string) {
    return this.adminCall(this.contracts.resolvers.fee, 'set_fee', { schema_uid: normalizeUid(schemaUid), token: token ?? null, amount });
  }

  async feeGetFee(schemaUid: string): Promise<ServiceResponse<{ token: string | null; amount: string } | null>> {
    return attempt(() => this.view(this.contracts.resolvers.fee, 'get_fee', { schema_uid: normalizeUid(schemaUid) }));
  }

  /** Prepays fees: NEAR via `deposit`, or a token via `ft_transfer_call`. */
  async feeDeposit(amount: string, token?: string): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const r = token
        ? await this.callRaw<void>(token, 'ft_transfer_call', { receiver_id: this.contracts.resolvers.fee, amount, msg: 'deposit' }, { deposit: 1n })
        : await this.callRaw<void>(this.contracts.resolvers.fee, 'deposit', {}, { deposit: amount });
      return { data: undefined, txHash: r.txHash };
    });
  }

  async feeGetBalance(accountId: string, token?: string): Promise<ServiceResponse<{ balance: string }>> {
    return attempt(async () => ({ balance: await this.view<string>(this.contracts.resolvers.fee, 'balance_of', { account_id: accountId, token: token ?? null }) }));
  }

  async feeCollected(schemaUid: string, token?: string): Promise<ServiceResponse<{ collected: string }>> {
    return attempt(async () => ({ collected: await this.view<string>(this.contracts.resolvers.fee, 'collected', { schema_uid: normalizeUid(schemaUid), token: token ?? null }) }));
  }

  /** The schema admin takes the fees collected. */
  feeWithdraw(schemaUid: string, token?: string) {
    return this.adminCall(this.contracts.resolvers.fee, 'withdraw_fees', { schema_uid: normalizeUid(schemaUid), token: token ?? null }, 0n);
  }

  /** A payer takes back unused prepaid balance. */
  feeWithdrawBalance(token?: string, amount?: string) {
    return this.adminCall(this.contracts.resolvers.fee, 'withdraw_balance', { token: token ?? null, amount: amount ?? null }, 0n);
  }

  tokenGatedSetConfig(schemaUid: string, token: string, minBalance: string) {
    return this.adminCall(this.contracts.resolvers.tokenGated, 'set_gate', { schema_uid: normalizeUid(schemaUid), token, min_balance: minBalance });
  }

  async tokenGatedGetConfig(schemaUid: string): Promise<ServiceResponse<{ token: string; min_balance: string } | null>> {
    return attempt(() => this.view(this.contracts.resolvers.tokenGated, 'get_gate', { schema_uid: normalizeUid(schemaUid) }));
  }

  tokenRewardSetConfig(schemaUid: string, token: string, amount: string) {
    return this.adminCall(this.contracts.resolvers.tokenReward, 'set_reward', { schema_uid: normalizeUid(schemaUid), token, amount });
  }

  /** Funds a schema's reward pool with its reward token. */
  async tokenRewardFund(schemaUid: string, token: string, amount: string): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const r = await this.callRaw<void>(
        token,
        'ft_transfer_call',
        { receiver_id: this.contracts.resolvers.tokenReward, amount, msg: JSON.stringify({ fund: normalizeUid(schemaUid) }) },
        { deposit: 1n },
      );
      return { data: undefined, txHash: r.txHash };
    });
  }

  async tokenRewardGetConfig(schemaUid: string): Promise<ServiceResponse<{ token: string; amount: string; pool: string; distributed_total: string } | null>> {
    return attempt(() => this.view(this.contracts.resolvers.tokenReward, 'get_reward', { schema_uid: normalizeUid(schemaUid) }));
  }

  async tokenRewardGetDistributed(schemaUid: string, accountId: string): Promise<ServiceResponse<{ distributed: string }>> {
    return attempt(async () => ({
      distributed: await this.view<string>(this.contracts.resolvers.tokenReward, 'distributed', { schema_uid: normalizeUid(schemaUid), account_id: accountId }),
    }));
  }

  /** Chains resolvers for a schema (cross-contract pipeline). */
  pipelineSetResolvers(schemaUid: string, resolvers: string[]) {
    return this.adminCall(this.contracts.resolvers.pipeline, 'set_pipeline', { schema_uid: normalizeUid(schemaUid), resolvers }, 3n * MILLINEAR);
  }

  async pipelineGetResolvers(schemaUid: string): Promise<ServiceResponse<{ resolvers: string[] }>> {
    return attempt(async () => ({ resolvers: await this.view<string[]>(this.contracts.resolvers.pipeline, 'get_pipeline', { schema_uid: normalizeUid(schemaUid) }) }));
  }

  // ──────────────────────────────────────────────────────────── credentials (NEP-171)

  async mintCredential(attestationUid: string): Promise<ServiceResponse<{ tokenId: string | null }>> {
    return this.write(async () => {
      const r = await this.callRaw<CredentialToken | null>(this.contracts.credentials, 'mint', { attestation_uid: normalizeUid(attestationUid) }, { deposit: 20n * MILLINEAR });
      if (!r.value) throw new Error('the credential could not be minted: the attestation must be active, you must be its attester or subject, and its subject a NEAR account');
      return { data: { tokenId: r.value.token_id }, txHash: r.txHash };
    });
  }

  async getCredential(attestationUid: string): Promise<ServiceResponse<CredentialToken | null>> {
    return attempt(() => this.view<CredentialToken | null>(this.contracts.credentials, 'credential_for_attestation', { attestation_uid: normalizeUid(attestationUid) }));
  }

  async listCredentials(ownerId: string): Promise<ServiceResponse<CredentialToken[]>> {
    return attempt(() => this.view<CredentialToken[]>(this.contracts.credentials, 'nft_tokens_for_owner', { account_id: ownerId, from_index: '0', limit: 100 }));
  }

  // ──────────────────────────────────────────────────────────── staking and the test token

  async stake(amount: string): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const r = await this.callRaw<void>(this.contracts.token, 'ft_transfer_call', { receiver_id: this.contracts.staking, amount, msg: 'stake' }, { deposit: 1n });
      return { data: undefined, txHash: r.txHash };
    });
  }

  async unstake(amount: string): Promise<ServiceResponse<void>> {
    return this.write(async () => {
      const r = await this.callRaw<void>(this.contracts.staking, 'unstake', { amount }, { deposit: 1n });
      return { data: undefined, txHash: r.txHash };
    });
  }

  async getStake(accountId: string): Promise<ServiceResponse<StakeInfo>> {
    return attempt(() => this.view<StakeInfo>(this.contracts.staking, 'get_stake', { account_id: accountId }));
  }

  async getTiers(): Promise<ServiceResponse<TierThreshold[]>> {
    return attempt(() => this.view<TierThreshold[]>(this.contracts.staking, 'get_tiers'));
  }

  /** Testnet only: 1,000 test tokens, once an hour. */
  async faucet(): Promise<ServiceResponse<{ amount: string }>> {
    return this.write(async () => {
      const r = await this.callRaw<string>(this.contracts.token, 'faucet', {});
      return { data: { amount: r.value }, txHash: r.txHash };
    });
  }

  async tokenBalance(accountId: string, token = this.contracts.token): Promise<ServiceResponse<{ balance: string }>> {
    return attempt(async () => ({ balance: await this.view<string>(token, 'ft_balance_of', { account_id: accountId }) }));
  }

  // ──────────────────────────────────────────────────────────── events and light client proofs

  async listEvents(q: { event?: string; contract?: string; account?: string; uid?: string; limit?: number; offset?: number } = {}) {
    return attempt(async () => {
      if (!this.indexer) throw new Error('events need indexerUrl');
      return this.indexer.listEvents(q);
    });
  }

  /** Proves a receipt (and the event line it logged) is in a final block. */
  async proveReceipt(receiptId: string, receiverId: string, expectedLog?: string): Promise<ServiceResponse<ProofResult>> {
    return attempt(() => proveReceipt(<T>(m: string, p: unknown) => this.rpc<T>(m, p), { receiptId, receiverId, expectedLog }));
  }

  /**
   * Proves the event that created (or revoked) an attestation is final: finds its transaction
   * through the indexer, its receipt through RPC, and checks the light client proof locally.
   */
  async proveAttestation(uid: string, which: 'attestation_created' | 'attestation_revoked' = 'attestation_created'): Promise<ServiceResponse<ProofResult & { txHash: string }>> {
    return attempt(async () => {
      if (!this.indexer) throw new Error('finding the transaction needs indexerUrl');
      const id = normalizeUid(uid);
      const events = await this.indexer.listEvents({ uid: id, event: which, limit: 1 });
      const ev = events.data[0];
      if (!ev) return fail(new Error(`no ${which} event for ${id}`), AttestraErrorType.NOT_FOUND);
      const receipt = await findEventReceipt(
        <T>(m: string, p: unknown) => this.rpc<T>(m, p),
        ev.tx_hash,
        ev.signer_id,
        (e) => e.event === which && (e.data?.[0] as { uid?: string })?.uid === id,
      );
      if (!receipt) return fail(new Error('event receipt not found'), AttestraErrorType.NOT_FOUND);
      const proof = await proveReceipt(<T>(m: string, p: unknown) => this.rpc<T>(m, p), { receiptId: receipt.receiptId, receiverId: receipt.executorId, expectedLog: receipt.log });
      return { ...proof, txHash: ev.tx_hash };
    });
  }

  // ──────────────────────────────────────────────────────────── only on NEAR: verdicts

  /** Text a wallet on another chain signs to link itself to `accountId`. */
  async linkWalletMessage(accountId: string, chain: 'eip155' | 'solana', address: string): Promise<ServiceResponse<{ message: string }>> {
    return attempt(async () => ({ message: await this.view<string>(this.contracts.verdicts, 'link_message', { account_id: accountId, chain, address }) }));
  }

  /** Links a wallet on another chain to the signer, proven by that wallet's signature. */
  async linkWallet(chain: 'eip155' | 'solana', address: string, signature: string): Promise<ServiceResponse<Outcome>> {
    return this.write(async () => {
      const r = await this.callRaw<Outcome>(this.contracts.verdicts, 'link_wallet', { chain, address, signature });
      return { data: r.value, txHash: r.txHash };
    });
  }

  async linkedAccount(caip10: string): Promise<ServiceResponse<{ accountId: string | null }>> {
    return attempt(async () => ({ accountId: await this.view<string | null>(this.contracts.verdicts, 'linked_account', { caip10 }) }));
  }

  /** Asks the NEAR MPC network to verify an event on another chain, then attests it (no oracle). */
  async attestForeignEvent(claim: {
    chain: string;
    txId: string;
    logIndex: number;
    log: Record<string, unknown>;
    subject?: string;
  }): Promise<ServiceResponse<Outcome>> {
    return this.write(async () => {
      const r = await this.callRaw<Outcome>(
        this.contracts.verdicts,
        'attest_foreign_event',
        { claim: { chain: claim.chain, tx_id: claim.txId.replace(/^0x/, ''), log_index: claim.logIndex, log: claim.log, subject: claim.subject ?? null } },
      );
      if (r.value?.status === 'failed') throw new Error('the MPC network did not verify the event');
      return { data: r.value, txHash: r.txHash };
    });
  }

  async verdictsConfig() {
    return attempt(() => this.view<Record<string, unknown>>(this.contracts.verdicts, 'get_config'));
  }

  /**
   * Private AI check: the evidence is encrypted in this process to the attested model's key and
   * sent to the Attestra agent, whose enclave checks it against the rule with a NEAR AI Cloud
   * verifiable model; the signed verdict becomes an attestation (only the evidence hash is stored).
   */
  async requestPrivateCheck(p: { ruleId: string; subject: string; evidence: string; github?: string }): Promise<
    ServiceResponse<{ outcome: Outcome; verdict: Record<string, unknown>; nearai: Record<string, unknown>; verifyUrl: string; txHash?: string }>
  > {
    return attempt(async () => {
      if (!this.agentUrl) throw new Error('private checks need agentUrl');
      const { encryptForModel } = await import('./e2ee');
      const keyRes = await fetch(`${this.agentUrl}/v1/check/model`);
      if (!keyRes.ok) throw new Error(`agent answered ${keyRes.status} for the model key`);
      const model = (await keyRes.json()) as { model: string; public_key: string };
      const encrypted = p.evidence ? encryptForModel(p.evidence, model.public_key) : '';
      const res = await fetch(`${this.agentUrl}/v1/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rule_id: p.ruleId, subject: p.subject, encrypted_evidence: encrypted, model: model.model, github: p.github ?? null }),
      });
      const body = (await res.json()) as { outcome?: Outcome; verdict?: Record<string, unknown>; nearai?: Record<string, unknown>; tx_hash?: string; error?: string };
      if (!res.ok || !body.outcome) throw new Error(body.error ?? `agent answered ${res.status}`);
      return ok({ outcome: body.outcome, verdict: body.verdict ?? {}, nearai: body.nearai ?? {}, verifyUrl: NEAR_AI_VERIFY_URL, txHash: body.tx_hash }, body.tx_hash);
    });
  }

  // ──────────────────────────────────────────────────────────── only on NEAR: Know Your Agent

  /** The owner registers an agent: an identity attestation about the agent account. */
  async registerAgent(p: {
    agent: string;
    name: string;
    model: string;
    capabilities: string[];
    endpoint: string;
    description?: string;
  }): Promise<ServiceResponse<{ attestationUid: string; status: string }>> {
    const owner = this.accountId;
    if (!owner) return fail(new Error('registering an agent needs a signer'), AttestraErrorType.CONFIGURATION_ERROR);
    let data: string;
    try {
      data = new SchemaEncoder(KNOWN_SCHEMAS.agentIdentity.definition).encode({
        name: p.name,
        owner,
        model: p.model,
        capabilities: p.capabilities,
        endpoint: p.endpoint,
        description: p.description ?? '',
      });
    } catch (e) {
      return fail(e, AttestraErrorType.VALIDATION_ERROR);
    }
    return this.createAttestation({ schemaUid: knownSchemaUid('agentIdentity'), subject: p.agent, data });
  }

  /** The owner lets the agent attest within a scope (schemas, expiry, max uses). */
  delegateToAgent(agent: string, scope: DelegateScope) {
    return this.addDelegate(agent, { ...scope, label: scope.label ?? 'agent' });
  }

  /** Anyone who hired the agent leaves a 1 to 5 review. */
  async rateAgent(p: { agent: string; score: number; comment?: string; jobRef?: string; identityUid?: string }) {
    if (!Number.isInteger(p.score) || p.score < 1 || p.score > 5) {
      return fail<{ attestationUid: string; status: string }>(new Error('score must be an integer from 1 to 5'), AttestraErrorType.VALIDATION_ERROR);
    }
    const data = new SchemaEncoder(KNOWN_SCHEMAS.agentReview.definition).encode({ score: p.score, comment: p.comment ?? '', job_ref: p.jobRef ?? '' });
    return this.createAttestation({ schemaUid: knownSchemaUid('agentReview'), subject: p.agent, data, refUid: p.identityUid });
  }

  async getAgentProfile(agent: string): Promise<ServiceResponse<AgentProfile>> {
    return attempt(async () => {
      if (!this.indexer) throw new Error('agent profiles need indexerUrl');
      return this.indexer.getAgent(agent);
    });
  }

  // ──────────────────────────────────────────────────────────── paid verification (x402)

  /** Calls a paid Attestra verification endpoint, paying with x402 (the test token on testnet). */
  async paidVerify(kind: 'claim' | 'agent', target: string, maxAmount?: bigint): Promise<ServiceResponse<{ result: unknown; settlement: SettlementResponse | null }>> {
    return attempt(async () => {
      if (!this.agentUrl) throw new Error('paid verification needs agentUrl');
      const url = `${this.agentUrl}/v1/paid/verify-${kind}?${kind === 'claim' ? 'uid' : 'agent'}=${encodeURIComponent(target)}`;
      const { response, settlement } = await payingFetch(this.near, this.signer(), this.network, url, {}, maxAmount);
      const body = await response.json();
      if (!response.ok) throw new Error((body as { error?: string }).error ?? `answered ${response.status}`);
      return { result: body, settlement };
    });
  }
}

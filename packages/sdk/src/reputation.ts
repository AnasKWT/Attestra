/**
 * Know Your Agent reputation rules, in one place. The indexer, the SDK's `getAgentProfile`, the
 * agent's paid `verify-agent`, the MCP tool and the site all read an agent through these functions.
 *
 * - An identity counts only when it is provably the owner's: its `owner` field equals its attester,
 *   and the attester is the agent account itself or an account the agent is a sub-account of.
 * - A review counts once per reviewer (their newest active review), and never when the reviewer is
 *   the agent, the owner, inside the owner's or the agent's account tree, or above the agent.
 * - A counted review is `paid` when its `job_ref` is the hash of a transaction in which the reviewer
 *   paid the agent (or its verified owner): a NEAR transfer, an NEP-141 `ft_transfer` or
 *   `ft_transfer_call`, or an x402 settlement relaying the reviewer's signed delegate action. The
 *   transaction is read from the chain; the text of `job_ref` alone proves nothing.
 * - An agent is trusted with a verified identity, at least one paid review and a paid average of at
 *   least 3.5.
 */

import { base58Decode } from './borsh';
import { SchemaEncoder } from './encoder';
import { KNOWN_SCHEMAS } from './schemas';

export type IdentityStatus = 'verified' | 'unverified' | 'none';

/** Why a review does not count. */
export type ExclusionReason = 'inactive' | 'invalid' | 'self_review' | 'owner' | 'owner_account' | 'agent_account' | 'agent_parent' | 'duplicate_reviewer';

export const EXCLUSION_REASONS: Record<ExclusionReason, string> = {
  inactive: 'the review is revoked or expired',
  invalid: 'the review data does not decode to a score from 1 to 5',
  self_review: 'the agent reviewed itself',
  owner: "the agent's owner reviewed it",
  owner_account: "the reviewer is a sub-account of the agent's owner",
  agent_account: 'the reviewer is a sub-account of the agent',
  agent_parent: 'the reviewer is an account the agent is a sub-account of',
  duplicate_reviewer: 'a newer review by the same reviewer counts instead',
};

/** The paid average an agent needs to be trusted. */
export const TRUSTED_MIN_PAID_AVERAGE = 3.5;

/** The asset name of a NEAR transfer in a `TxPayment`. */
export const NEAR_ASSET = 'NEAR';

/** The attestation fields the rules read (an `IndexedAttestation` has them all). */
export interface AttestationLike {
  uid: string;
  attester: string;
  subject: string;
  data: string;
  status: string;
  created_at: number;
}

/** One payment found in a transaction: who signed it, who received it, what and how much. */
export interface TxPayment {
  payer: string;
  payee: string;
  /** `NEAR`, or the NEP-141 contract. */
  asset: string;
  /** In the asset's smallest unit (yoctoNEAR for NEAR); for tokens, the net amount the token's events moved. */
  amount: string;
  method: 'transfer' | 'ft_transfer' | 'ft_transfer_call';
  /** The account that submitted the reviewer's signed delegate action (an x402 settlement), or null when the payer signed the transaction. */
  relayer: string | null;
}

/** What the chain says about a transaction hash. */
export interface TxLookup {
  found: boolean;
  /** Every receipt executed in a final block. */
  final: boolean;
  payments: TxPayment[];
}

export interface PaymentVerdict {
  paid: boolean;
  /** Why the review is not paid; null when it is. */
  reason: string | null;
  payment: TxPayment | null;
}

export type ReputationReview<T extends AttestationLike> = T & {
  fields: Record<string, unknown> | null;
  counted: boolean;
  excluded_reason: ExclusionReason | null;
  paid: boolean;
  payment: TxPayment | null;
  /** Why a counted review is not paid; null for paid and excluded reviews. */
  payment_reason: string | null;
};

export interface AgentTrust {
  trusted: boolean;
  /** Why the agent is not trusted; empty when it is. */
  trust_reasons: string[];
}

export interface AgentReputation<I extends AttestationLike = AttestationLike, R extends AttestationLike = AttestationLike> extends AgentTrust {
  /** The newest verified identity, or the newest active identity when none is verified. */
  identity: I | null;
  identity_fields: Record<string, unknown> | null;
  identity_status: IdentityStatus;
  /** Why the identity is unverified; null otherwise. */
  identity_reason: string | null;
  reviews: Array<ReputationReview<R>>;
  /** Counted reviews only. */
  review_count: number;
  average_score: number | null;
  paid_review_count: number;
  paid_average_score: number | null;
  excluded_review_count: number;
  excluded_reasons: Partial<Record<ExclusionReason, number>>;
}

export interface ReputationOptions {
  /**
   * Assets a payment may be made in: `NEAR` and NEP-141 contract ids. Null accepts any asset.
   * Pass the deployment's payment token and `NEAR`, so a reviewer cannot pay in a token they minted.
   */
  acceptedAssets?: string[] | null;
}

// ──────────────────────────────────────────────────────────── accounts

/** `account` is a sub-account of `parent` at any depth (`bot.alice.testnet` of `alice.testnet` and of `testnet`). */
export function isSubAccount(account: string, parent: string): boolean {
  return parent.length > 0 && account.length > parent.length + 1 && account.endsWith(`.${parent}`);
}

/** `account` is `root` itself or one of its sub-accounts. */
export function inAccountTree(account: string, root: string): boolean {
  return account === root || isSubAccount(account, root);
}

// ──────────────────────────────────────────────────────────── identity

function decodeFields(definition: string, data: string): Record<string, unknown> | null {
  try {
    return new SchemaEncoder(definition).decode(data);
  } catch {
    return null;
  }
}

export interface IdentityVerdict {
  status: 'verified' | 'unverified';
  reason: string | null;
  fields: Record<string, unknown> | null;
  /** The owner named in the identity (verified or not), when it decodes. */
  owner: string | null;
}

/** Whether one identity attestation is provably the owner's. */
export function judgeIdentity(agent: string, identity: AttestationLike): IdentityVerdict {
  const fields = decodeFields(KNOWN_SCHEMAS.agentIdentity.definition, identity.data);
  const owner = fields && typeof fields.owner === 'string' ? fields.owner : null;
  const unverified = (reason: string): IdentityVerdict => ({ status: 'unverified', reason, fields, owner });
  if (identity.subject !== agent) return unverified(`the identity is about ${identity.subject}, not ${agent}`);
  if (identity.status !== 'active') return unverified(`the identity is ${identity.status}`);
  if (!fields || owner === null) return unverified('the identity data does not decode');
  if (owner !== identity.attester) return unverified(`the identity names ${owner} as owner, but ${identity.attester} attested it`);
  if (identity.attester === agent || isSubAccount(agent, identity.attester)) return { status: 'verified', reason: null, fields, owner };
  return unverified(`${identity.attester} is neither ${agent} nor an account it is a sub-account of, so it cannot prove it owns the agent`);
}

/** The identity a profile shows: the newest verified one, else the newest active one. */
export function pickIdentity<I extends AttestationLike>(agent: string, identities: I[]): { identity: I | null; verdict: IdentityVerdict | null } {
  const active = newestFirst(identities.filter((i) => i.subject === agent && i.status === 'active'));
  const judged = active.map((identity) => ({ identity, verdict: judgeIdentity(agent, identity) }));
  return judged.find((j) => j.verdict.status === 'verified') ?? judged[0] ?? { identity: null, verdict: null };
}

function newestFirst<T extends AttestationLike>(list: T[]): T[] {
  return [...list].sort((a, b) => b.created_at - a.created_at || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
}

// ──────────────────────────────────────────────────────────── payments

/** A NEAR transaction hash: base58 of 32 bytes. */
export function isTxHash(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(s)) return false;
  try {
    return base58Decode(s).length === 32;
  } catch {
    return false;
  }
}

/** The parts of a `tx` RPC result the rules read. */
export interface RpcTxResult {
  final_execution_status?: string;
  status?: unknown;
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] };
  receipts_outcome: Array<{ id?: string; outcome: { executor_id: string; logs: string[]; status: unknown } }>;
}

interface ActionSet {
  signer: string;
  receiver: string;
  actions: unknown[];
  relayer: string | null;
}

const isFailure = (status: unknown) => Boolean(status && typeof status === 'object' && 'Failure' in status);
const isSuccess = (status: unknown) => Boolean(status && typeof status === 'object' && ('SuccessValue' in status || 'SuccessReceiptId' in status));

function decodeArgs(args: unknown): Record<string, unknown> | null {
  if (typeof args !== 'string') return args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
  try {
    const text = typeof Buffer !== 'undefined' ? Buffer.from(args, 'base64').toString('utf8') : new TextDecoder().decode(Uint8Array.from(atob(args), (c) => c.charCodeAt(0)));
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const toAmount = (v: unknown): bigint => {
  try {
    return typeof v === 'string' || typeof v === 'number' ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
};

/** NEP-141 `ft_transfer` events in successful receipts the token itself executed. */
function tokenTransfers(r: RpcTxResult, token: string): Array<{ from: string; to: string; amount: bigint }> {
  const out: Array<{ from: string; to: string; amount: bigint }> = [];
  for (const o of r.receipts_outcome) {
    if (o.outcome.executor_id !== token || !isSuccess(o.outcome.status)) continue;
    for (const log of o.outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      let ev: { standard?: string; event?: string; data?: Array<{ old_owner_id?: string; new_owner_id?: string; amount?: string }> };
      try {
        ev = JSON.parse(log.slice('EVENT_JSON:'.length));
      } catch {
        continue;
      }
      if (ev.standard !== 'nep141' || ev.event !== 'ft_transfer' || !Array.isArray(ev.data)) continue;
      for (const d of ev.data) if (d.old_owner_id && d.new_owner_id) out.push({ from: d.old_owner_id, to: d.new_owner_id, amount: toAmount(d.amount) });
    }
  }
  return out;
}

/**
 * Every payment a transaction made, read from its signed actions and checked against its receipts:
 * NEAR transfers count only when no receipt failed, and token transfers by the net amount the
 * token's own NEP-141 events moved (so an `ft_transfer_call` the receiver refunded counts as zero).
 * Actions inside a signed delegate action are the delegate sender's, with the transaction signer as
 * the relayer.
 */
export function txPayments(r: RpcTxResult): TxPayment[] {
  const t = r.transaction;
  const sets: ActionSet[] = [{ signer: t.signer_id, receiver: t.receiver_id, actions: t.actions ?? [], relayer: null }];
  for (const a of t.actions ?? []) {
    const d = (a as { Delegate?: { delegate_action?: { sender_id: string; receiver_id: string; actions: unknown[] } } }).Delegate?.delegate_action;
    if (d) sets.push({ signer: d.sender_id, receiver: d.receiver_id, actions: d.actions ?? [], relayer: t.signer_id });
  }
  const failed = isFailure(r.status) || r.receipts_outcome.some((o) => isFailure(o.outcome.status));
  const near = new Map<string, TxPayment & { sum: bigint }>();
  const tokens = new Map<string, { set: ActionSet; token: string; payee: string; method: 'ft_transfer' | 'ft_transfer_call' }>();
  for (const set of sets) {
    for (const a of set.actions) {
      if (!a || typeof a !== 'object') continue;
      const transfer = (a as { Transfer?: { deposit?: string } }).Transfer;
      if (transfer && !failed) {
        const amount = toAmount(transfer.deposit);
        if (amount <= 0n) continue;
        const key = `${set.signer}\n${set.receiver}`;
        const prev = near.get(key);
        const sum = (prev?.sum ?? 0n) + amount;
        near.set(key, { payer: set.signer, payee: set.receiver, asset: NEAR_ASSET, amount: sum.toString(), method: 'transfer', relayer: set.relayer, sum });
      }
      const call = (a as { FunctionCall?: { method_name?: string; args?: unknown } }).FunctionCall;
      if (call && (call.method_name === 'ft_transfer' || call.method_name === 'ft_transfer_call')) {
        const args = decodeArgs(call.args);
        const payee = typeof args?.receiver_id === 'string' ? args.receiver_id : null;
        if (!payee) continue;
        const key = `${set.signer}\n${set.receiver}\n${payee}`;
        if (!tokens.has(key)) tokens.set(key, { set, token: set.receiver, payee, method: call.method_name });
      }
    }
  }
  const out: TxPayment[] = [...near.values()].map(({ sum: _sum, ...p }) => p);
  for (const { set, token, payee, method } of tokens.values()) {
    let net = 0n;
    for (const e of tokenTransfers(r, token)) {
      if (e.from === set.signer && e.to === payee) net += e.amount;
      else if (e.from === payee && e.to === set.signer) net -= e.amount;
    }
    if (net > 0n) out.push({ payer: set.signer, payee, asset: token, amount: net.toString(), method, relayer: set.relayer });
  }
  return out;
}

/** The lookup result for a `tx` RPC answer. */
export function lookupFromTx(r: RpcTxResult): TxLookup {
  const status = r.final_execution_status;
  return { found: true, final: status === undefined ? isSuccess(r.status) || isFailure(r.status) : status === 'FINAL', payments: txPayments(r) };
}

/** Whether `jobRef` proves that `reviewer` paid one of `payees`. */
export function judgePayment(jobRef: string, reviewer: string, payees: string[], lookup: TxLookup | null | undefined, opts: ReputationOptions = {}): PaymentVerdict {
  const unpaid = (reason: string): PaymentVerdict => ({ paid: false, reason, payment: null });
  const hash = jobRef.trim();
  if (!hash) return unpaid('no job_ref');
  if (!isTxHash(hash)) return unpaid('job_ref is not a NEAR transaction hash');
  if (!lookup) return unpaid('the payment could not be checked on chain yet');
  if (!lookup.found) return unpaid('no transaction with this hash on chain');
  if (!lookup.final) return unpaid('the transaction is not final yet');
  const byReviewer = lookup.payments.filter((p) => p.payer === reviewer);
  const toAgent = byReviewer.filter((p) => payees.includes(p.payee));
  if (!toAgent.length) return unpaid(byReviewer.length ? 'the transaction pays another account, not the agent' : 'the transaction is not a payment signed by the reviewer');
  const accepted = opts.acceptedAssets ? toAgent.filter((p) => opts.acceptedAssets!.includes(p.asset)) : toAgent;
  if (!accepted.length) return unpaid(`the payment is in ${toAgent[0].asset}, which is not an accepted payment asset`);
  return { paid: true, reason: null, payment: accepted[0] };
}

// ──────────────────────────────────────────────────────────── reviews and trust

interface ReviewContext {
  agent: string;
  /** Accounts whose trees are excluded as the owner's: the verified owner, or the claimed owner and attester of an unverified identity. */
  owners: string[];
  /** Accounts a payment may go to: the agent, and its verified owner. */
  payees: string[];
}

function contextOf(agent: string, verdict: IdentityVerdict | null, identity: AttestationLike | null): ReviewContext {
  if (verdict?.status === 'verified' && verdict.owner) return { agent, owners: [verdict.owner], payees: [...new Set([agent, verdict.owner])] };
  const owners = verdict && identity ? [...new Set([identity.attester, verdict.owner].filter((x): x is string => Boolean(x)))] : [];
  return { agent, owners, payees: [agent] };
}

function exclusionOf(ctx: ReviewContext, reviewer: string): ExclusionReason | null {
  if (reviewer === ctx.agent) return 'self_review';
  if (ctx.owners.includes(reviewer)) return 'owner';
  if (isSubAccount(reviewer, ctx.agent)) return 'agent_account';
  if (ctx.owners.some((o) => isSubAccount(reviewer, o))) return 'owner_account';
  if (isSubAccount(ctx.agent, reviewer)) return 'agent_parent';
  return null;
}

/** The reviews that need a payment check: counted reviews whose job_ref looks like a transaction hash. */
export function paymentQueries(agent: string, identities: AttestationLike[], reviews: AttestationLike[]): Array<{ txHash: string; senders: string[] }> {
  const { identity, verdict } = pickIdentity(agent, identities);
  const ctx = contextOf(agent, verdict, identity);
  const out = new Map<string, Set<string>>();
  for (const r of classify(ctx, reviews)) {
    const job = typeof r.fields?.job_ref === 'string' ? r.fields.job_ref.trim() : '';
    if (!r.counted || !isTxHash(job)) continue;
    const senders = out.get(job) ?? new Set<string>();
    for (const s of [r.attester, ...ctx.payees]) senders.add(s);
    out.set(job, senders);
  }
  return [...out].map(([txHash, senders]) => ({ txHash, senders: [...senders] }));
}

function classify<R extends AttestationLike>(ctx: ReviewContext, reviews: R[]): Array<R & { fields: Record<string, unknown> | null; counted: boolean; excluded_reason: ExclusionReason | null }> {
  // Reviews about another account are not this agent's reviews at all.
  const judged = reviews.filter((r) => r.subject === ctx.agent).map((r) => {
    const fields = decodeFields(KNOWN_SCHEMAS.agentReview.definition, r.data);
    const score = Number(fields?.score);
    let excluded: ExclusionReason | null = null;
    if (r.status !== 'active') excluded = 'inactive';
    else if (!fields || !Number.isInteger(score) || score < 1 || score > 5) excluded = 'invalid';
    else excluded = exclusionOf(ctx, r.attester);
    return { ...r, fields, counted: excluded === null, excluded_reason: excluded };
  });
  const seen = new Set<string>();
  for (const r of newestFirst(judged)) {
    if (!r.counted) continue;
    if (seen.has(r.attester)) {
      r.counted = false;
      r.excluded_reason = 'duplicate_reviewer';
    }
    seen.add(r.attester);
  }
  return judged;
}

const average = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

/** Whether an agent is trusted, with the reasons when it is not. */
export function agentTrust(p: Pick<AgentReputation, 'identity_status' | 'identity_reason' | 'paid_review_count' | 'paid_average_score'>): AgentTrust {
  const reasons: string[] = [];
  if (p.identity_status === 'none') reasons.push('no identity attestation about the agent');
  if (p.identity_status === 'unverified') reasons.push(`the identity is unverified: ${p.identity_reason ?? 'its attester is not the owner'}`);
  if (p.paid_review_count < 1) reasons.push('no paid review: a review counts as paid when its job_ref is the hash of a transaction paying the agent from the reviewer');
  else if ((p.paid_average_score ?? 0) < TRUSTED_MIN_PAID_AVERAGE) reasons.push(`the paid reviews average ${p.paid_average_score}, below ${TRUSTED_MIN_PAID_AVERAGE}`);
  return { trusted: reasons.length === 0, trust_reasons: reasons };
}

/**
 * Applies every rule to an agent's identity and review attestations, given what the chain said
 * about each job_ref (`lookups`, by transaction hash; a missing entry means not checked).
 */
export function evaluateReputation<I extends AttestationLike, R extends AttestationLike>(
  input: { agent: string; identities: I[]; reviews: R[]; lookups?: Map<string, TxLookup | null> | Record<string, TxLookup | null> },
  opts: ReputationOptions = {},
): AgentReputation<I, R> {
  const { agent } = input;
  const lookups = input.lookups instanceof Map ? input.lookups : new Map(Object.entries(input.lookups ?? {}));
  const { identity, verdict } = pickIdentity(agent, input.identities);
  const ctx = contextOf(agent, verdict, identity);
  const reviews: Array<ReputationReview<R>> = classify(ctx, input.reviews).map((r) => {
    if (!r.counted) return { ...r, paid: false, payment: null, payment_reason: null };
    const job = typeof r.fields?.job_ref === 'string' ? r.fields.job_ref : '';
    const v = judgePayment(job, r.attester, ctx.payees, lookups.get(job.trim()), opts);
    return { ...r, paid: v.paid, payment: v.payment, payment_reason: v.reason };
  });
  const counted = reviews.filter((r) => r.counted);
  const paid = counted.filter((r) => r.paid);
  const excluded_reasons: Partial<Record<ExclusionReason, number>> = {};
  for (const r of reviews) if (r.excluded_reason) excluded_reasons[r.excluded_reason] = (excluded_reasons[r.excluded_reason] ?? 0) + 1;
  const base = {
    identity,
    identity_fields: verdict?.fields ?? null,
    identity_status: (verdict?.status ?? 'none') as IdentityStatus,
    identity_reason: verdict?.reason ?? null,
    reviews,
    review_count: counted.length,
    average_score: average(counted.map((r) => Number(r.fields?.score))),
    paid_review_count: paid.length,
    paid_average_score: average(paid.map((r) => Number(r.fields?.score))),
    excluded_review_count: reviews.length - counted.length,
    excluded_reasons,
  };
  return { ...base, ...agentTrust(base) };
}

/** Looks a transaction up on chain; null when the chain could not be asked (nothing is concluded). */
export type TxLookupFn = (txHash: string, senders: string[]) => Promise<TxLookup | null>;

/** `evaluateReputation` after looking up every job_ref that needs it. */
export async function assessReputation<I extends AttestationLike, R extends AttestationLike>(
  input: { agent: string; identities: I[]; reviews: R[] },
  lookup: TxLookupFn,
  opts: ReputationOptions = {},
): Promise<AgentReputation<I, R>> {
  const queries = paymentQueries(input.agent, input.identities, input.reviews);
  const lookups = new Map<string, TxLookup | null>();
  await Promise.all(queries.map(async (q) => lookups.set(q.txHash, await lookup(q.txHash, q.senders).catch(() => null))));
  return evaluateReputation({ ...input, lookups }, opts);
}

// ──────────────────────────────────────────────────────────── chain lookups and caches

export interface CachedTxLookup extends TxLookup {
  /** Unix seconds. */
  checked_at: number;
}

/** Where verdicts about transactions are kept: final transactions for good, unknown hashes for a while. */
export interface TxLookupCache {
  get(txHash: string): Promise<CachedTxLookup | null | undefined> | CachedTxLookup | null | undefined;
  set(txHash: string, entry: CachedTxLookup): Promise<void> | void;
}

/** An in-memory cache holding at most `max` entries (oldest dropped first). */
export class MemoryTxCache implements TxLookupCache {
  private readonly map = new Map<string, CachedTxLookup>();
  constructor(private readonly max = 2000) {}
  get(txHash: string) {
    return this.map.get(txHash);
  }
  set(txHash: string, entry: CachedTxLookup) {
    this.map.delete(txHash);
    this.map.set(txHash, entry);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

export type RpcCall = <T>(method: string, params: unknown) => Promise<T>;

const NOT_FOUND = new Set(['UNKNOWN_TRANSACTION', 'UNKNOWN_TRANSACTION_OR_RECEIPT']);

/**
 * A `TxLookupFn` over the `tx` RPC method (pass `AttestraClient.rpc`, which asks the archival
 * endpoint for old transactions). It asks with each sender in turn, caches final answers, keeps an
 * unknown hash for `notFoundTtlS` (a transaction may still be submitted later), runs at most
 * `concurrency` lookups at once and shares one lookup per hash.
 */
export function rpcTxLookup(rpc: RpcCall, cache: TxLookupCache = new MemoryTxCache(), opts: { notFoundTtlS?: number; concurrency?: number; now?: () => number } = {}): TxLookupFn {
  const ttl = opts.notFoundTtlS ?? 600;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const limit = opts.concurrency ?? 4;
  const inflight = new Map<string, Promise<TxLookup | null>>();
  let running = 0;
  const queue: Array<() => void> = [];
  const slot = async () => {
    if (running >= limit) await new Promise<void>((r) => queue.push(r));
    running++;
  };
  const release = () => {
    running--;
    queue.shift()?.();
  };

  async function fetchOne(txHash: string, senders: string[]): Promise<TxLookup | null> {
    const cached = await cache.get(txHash);
    if (cached && (cached.final || (!cached.found && now() - cached.checked_at < ttl))) return { found: cached.found, final: cached.final, payments: cached.payments };
    await slot();
    try {
      for (const sender of senders) {
        try {
          const r = await rpc<RpcTxResult>('tx', { tx_hash: txHash, sender_account_id: sender, wait_until: 'NONE' });
          if (!r?.transaction || r.transaction.hash !== txHash) continue;
          const found = lookupFromTx(r);
          if (found.final) await cache.set(txHash, { ...found, checked_at: now() });
          return found;
        } catch (e) {
          if (!NOT_FOUND.has(String((e as { cause?: unknown }).cause ?? ''))) return null;
        }
      }
      const missing: TxLookup = { found: false, final: false, payments: [] };
      await cache.set(txHash, { ...missing, checked_at: now() });
      return missing;
    } finally {
      release();
    }
  }

  return (txHash, senders) => {
    const key = `${txHash}\n${senders.join(',')}`;
    let p = inflight.get(key);
    if (!p) {
      p = fetchOne(txHash, senders).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };
}

// ──────────────────────────────────────────────────────────── recent payments (for review forms)

interface FastNearTx {
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] };
  execution_outcome: { outcome: { executor_id: string; logs: string[]; status: unknown } };
  receipts: Array<{ execution_outcome: { id?: string; outcome: { executor_id: string; logs: string[]; status: unknown } } }>;
}

/**
 * The payer's recent payments to any of `payees`, newest first, read from FastNEAR's transactions
 * API (`NetworkConfig.txApiUrl`). Only a suggestion for a review's job_ref: profiles verify the
 * transaction again over RPC.
 */
export async function recentPayments(
  txApiUrl: string,
  payer: string,
  payees: string[],
  opts: { scan?: number; fetchImpl?: typeof fetch } = {},
): Promise<Array<{ txHash: string; blockHeight: number; payment: TxPayment }>> {
  const f = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = txApiUrl.replace(/\/+$/, '');
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await f(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`transactions API answered ${res.status} for ${path}`);
    return JSON.parse((await res.text()).replace(/"(block_timestamp|tx_block_timestamp)":\s*(\d+)/g, '"$1":"$2"')) as T;
  };
  const list = await post<{ account_txs: Array<{ transaction_hash: string; tx_block_height: number; is_signer?: boolean; is_delegated_signer?: boolean; is_success?: boolean }> }>('/v0/account', {
    account_id: payer,
    limit: 100,
  });
  const candidates = list.account_txs.filter((t) => (t.is_signer || t.is_delegated_signer) && t.is_success !== false).slice(0, Math.min(opts.scan ?? 20, 20));
  if (!candidates.length) return [];
  const heights = new Map(candidates.map((t) => [t.transaction_hash, t.tx_block_height]));
  const { transactions } = await post<{ transactions: FastNearTx[] }>('/v0/transactions', { tx_hashes: candidates.map((t) => t.transaction_hash) });
  const out: Array<{ txHash: string; blockHeight: number; payment: TxPayment }> = [];
  for (const t of transactions ?? []) {
    const rpcShape: RpcTxResult = {
      transaction: t.transaction,
      status: t.execution_outcome?.outcome.status,
      receipts_outcome: (t.receipts ?? []).map((r) => ({ id: r.execution_outcome.id, outcome: r.execution_outcome.outcome })),
    };
    const payment = txPayments(rpcShape).find((p) => p.payer === payer && payees.includes(p.payee));
    if (payment) out.push({ txHash: t.transaction.hash, blockHeight: heights.get(t.transaction.hash) ?? 0, payment });
  }
  return out.sort((a, b) => b.blockHeight - a.blockHeight);
}

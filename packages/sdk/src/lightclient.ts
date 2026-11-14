/**
 * Light client proofs: prove that a receipt (and the event it logged) is part of a final NEAR
 * block, without trusting the indexer or the RPC.
 *
 * Steps, all computed locally:
 * 1. Start from a checkpoint pinned in the SDK (`checkpoints.ts`): a block hash and the block
 *    producers of the epoch after it. Walk forward epoch by epoch with `next_light_client_block`,
 *    as NEAR's light client spec does: each block must be in the trusted epoch or the next one, be
 *    approved by producers holding more than 2/3 of that epoch's stake (ed25519 over the Borsh
 *    approval message), and its `next_bps` must hash to its `inner_lite.next_bp_hash` before it is
 *    trusted as the following epoch's producer set. The walk ends at a recent final block: the head.
 * 2. Fetch `EXPERIMENTAL_light_client_proof` for the receipt against that head.
 * 3. Hash the execution outcome, walk the outcome proof to the shard outcome root, walk the outcome
 *    root proof to the block's outcome root and compare it with the block header; compute the
 *    block's hash from its header and walk the block proof to the head's block merkle root.
 * 4. Check the event line is among the outcome's logs.
 *
 * What it trusts: the pinned checkpoint, and the honesty of more than 2/3 of stake in every epoch
 * since it. The RPC only supplies data that is checked; a lying RPC can make a proof fail, never pass.
 * The walk is cached per client (or per `rpc` function), so only the first proof walks every epoch.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { BorshWriter, base58Decode, base58Encode, base64ToBytes } from './borsh';
import { CHECKPOINTS, type LightClientCheckpoint } from './checkpoints';
import type { Network } from './types';

export interface MerklePathItem {
  hash: string;
  direction: 'Left' | 'Right';
}

export interface InnerLite {
  height: number;
  epoch_id: string;
  next_epoch_id: string;
  prev_state_root: string;
  outcome_root: string;
  timestamp: number;
  timestamp_nanosec: string;
  next_bp_hash: string;
  block_merkle_root: string;
}

/** The header fields that are hashed (`timestamp` is the lossy number twin of `timestamp_nanosec`). */
type HeaderInnerLite = Omit<InnerLite, 'timestamp'>;

export interface LightClientBlock {
  prev_block_hash: string;
  next_block_inner_hash: string;
  inner_lite: InnerLite;
  inner_rest_hash: string;
  next_bps: ValidatorStakeView[] | null;
  approvals_after_next: Array<string | null>;
}

/** A block producer as the RPC shows it (`next_bps` entries, `EXPERIMENTAL_validators_ordered`). */
export interface ValidatorStakeView {
  account_id: string;
  public_key: string;
  stake: string;
  /** Only `V1` exists; a pinned checkpoint may leave it out. */
  validator_stake_struct_version?: string;
}

interface OutcomeView {
  logs: string[];
  receipt_ids: string[];
  gas_burnt: number;
  tokens_burnt: string;
  executor_id: string;
  status: Record<string, unknown> | string;
}

export interface LightClientProof {
  outcome_proof: { proof: MerklePathItem[]; block_hash: string; id: string; outcome: OutcomeView };
  outcome_root_proof: MerklePathItem[];
  block_header_lite: { prev_block_hash: string; inner_rest_hash: string; inner_lite: InnerLite };
  block_proof: MerklePathItem[];
}

export interface ProofCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProofResult {
  verified: boolean;
  checks: ProofCheck[];
  head: { hash: string; height: number; approvedStake: string; totalStake: string };
  block: { hash: string; height: number; timestamp: number };
  receiptId: string;
  executorId: string;
  logs: string[];
  /** The pinned checkpoint the head's validator set was chained from. */
  checkpoint: { network: string; hash: string; height: number };
  /** Epochs walked from the checkpoint to the head, each checked against the previous epoch's producers. */
  epochsWalked: number;
}

export type RpcCall = <T>(method: string, params: unknown) => Promise<T>;

const b58 = (s: string) => base58Decode(s);
const combine = (a: Uint8Array, b: Uint8Array) => {
  const c = new Uint8Array(64);
  c.set(a, 0);
  c.set(b, 32);
  return sha256(c);
};

export function computeRootFromPath(path: MerklePathItem[], leaf: Uint8Array): Uint8Array {
  let h = leaf;
  for (const item of path) h = item.direction === 'Left' ? combine(b58(item.hash), h) : combine(h, b58(item.hash));
  return h;
}

function innerLiteBytes(i: HeaderInnerLite): Uint8Array {
  return new BorshWriter()
    .u64(i.height)
    .fixed(b58(i.epoch_id))
    .fixed(b58(i.next_epoch_id))
    .fixed(b58(i.prev_state_root))
    .fixed(b58(i.outcome_root))
    .u64(BigInt(i.timestamp_nanosec))
    .fixed(b58(i.next_bp_hash))
    .fixed(b58(i.block_merkle_root))
    .toBytes();
}

/** Block hash from the light header: sha256(sha256(sha256(inner_lite) ++ inner_rest_hash) ++ prev_hash). */
export function blockHashFromHeader(h: { prev_block_hash: string; inner_rest_hash: string; inner_lite: HeaderInnerLite }): Uint8Array {
  const innerHash = combine(sha256(innerLiteBytes(h.inner_lite)), b58(h.inner_rest_hash));
  return combine(innerHash, b58(h.prev_block_hash));
}

function statusBytes(w: BorshWriter, status: OutcomeView['status']): void {
  if (typeof status === 'string') {
    // "Unknown" or "Failure" without details
    w.u8(status === 'Unknown' ? 0 : 1);
    return;
  }
  if ('SuccessValue' in status) {
    w.u8(2).bytes(base64ToBytes(String(status.SuccessValue ?? '')));
  } else if ('SuccessReceiptId' in status) {
    w.u8(3).fixed(b58(String(status.SuccessReceiptId)));
  } else if ('Failure' in status) {
    w.u8(1);
  } else {
    w.u8(0);
  }
}

/** sha256(borsh(Vec<CryptoHash>)) over [id, hash(partial outcome), hash(log) for each log]. */
export function outcomeHash(id: string, o: OutcomeView): Uint8Array {
  const partial = new BorshWriter();
  partial.u32(o.receipt_ids.length);
  for (const r of o.receipt_ids) partial.fixed(b58(r));
  partial.u64(BigInt(o.gas_burnt)).uint(BigInt(o.tokens_burnt), 128).string(o.executor_id);
  statusBytes(partial, o.status);
  const hashes = [b58(id), sha256(partial.toBytes()), ...o.logs.map((l) => sha256(new TextEncoder().encode(l)))];
  const w = new BorshWriter().u32(hashes.length);
  for (const h of hashes) w.fixed(h);
  return sha256(w.toBytes());
}

/** The message block producers sign to endorse the block after `block_view`. */
export function approvalMessage(lcb: LightClientBlock): { headHash: Uint8Array; message: Uint8Array } {
  const headHash = blockHashFromHeader(lcb);
  const nextBlockHash = combine(b58(lcb.next_block_inner_hash), headHash);
  const message = new BorshWriter().u8(0).fixed(nextBlockHash).u64(lcb.inner_lite.height + 2).toBytes();
  return { headHash, message };
}

/**
 * Checks a light client block's approvals against its epoch's ordered block producers; returns the
 * approved and total stake. Only valid ed25519 signatures count; a bad one adds no stake.
 */
export function checkApprovals(lcb: LightClientBlock, producers: ValidatorStakeView[]): { ok: boolean; approved: bigint; total: bigint; detail: string } {
  const { message } = approvalMessage(lcb);
  let approved = 0n;
  let total = 0n;
  let bad = 0;
  producers.forEach((bp, i) => {
    total += BigInt(bp.stake);
    const sig = lcb.approvals_after_next[i];
    if (!sig) return;
    if (!bp.public_key.startsWith('ed25519:') || !sig.startsWith('ed25519:')) return;
    let valid = false;
    try {
      valid = ed25519.verify(b58(sig.slice(8)), message, b58(bp.public_key.slice(8)));
    } catch {
      // malformed signature or key: no stake
    }
    if (valid) approved += BigInt(bp.stake);
    else bad++;
  });
  const ok = total > 0n && approved * 3n > total * 2n;
  return { ok, approved, total, detail: `${approved}/${total} stake signed${bad ? `, ${bad} bad signatures ignored` : ''}` };
}

function publicKeyBytes(w: BorshWriter, key: string): void {
  const [type, data] = key.split(':');
  const bytes = b58(data ?? '');
  if (type === 'ed25519' && bytes.length === 32) w.u8(0).fixed(bytes);
  else if (type === 'secp256k1' && bytes.length === 64) w.u8(1).fixed(bytes);
  else throw new LightClientError(`unsupported block producer key ${key}`);
}

/** sha256(borsh(Vec<ValidatorStake>)): the `next_bp_hash` a block header commits to for `next_bps`. */
export function blockProducersHash(bps: ValidatorStakeView[]): Uint8Array {
  const w = new BorshWriter().u32(bps.length);
  for (const bp of bps) {
    if ((bp.validator_stake_struct_version ?? 'V1') !== 'V1') throw new LightClientError(`unsupported validator stake version ${bp.validator_stake_struct_version}`);
    w.u8(0).string(bp.account_id);
    publicKeyBytes(w, bp.public_key);
    w.uint(BigInt(bp.stake), 128);
  }
  return sha256(w.toBytes());
}

/** A light client block, or the pinned checkpoint, failed a check: the chain of trust is broken. */
export class LightClientError extends Error {
  override name = 'LightClientError';
}

/** The light client's state: the latest block it trusts and the producers of its epoch and the next. */
export interface TrustedHead {
  hash: string;
  height: number;
  epochId: string;
  nextEpochId: string;
  /** The head's header fields (its block merkle root anchors the block proof). */
  innerLite: HeaderInnerLite;
  /** Producers of `epochId`; null at the checkpoint, whose own epoch the light client never needs. */
  epochBps: ValidatorStakeView[] | null;
  /** Producers of `nextEpochId`, committed to by the head's `next_bp_hash`. */
  nextBps: ValidatorStakeView[];
  /** The approvals that made this block trusted; null for the checkpoint itself. */
  approval: { approved: bigint; total: bigint; detail: string } | null;
  /** Epoch boundaries crossed since the checkpoint. */
  epochsWalked: number;
}

/** The checkpoint as the first trusted head, after checking its fields hash to its pinned block hash and producer set hash. */
export function headFromCheckpoint(cp: LightClientCheckpoint): TrustedHead {
  const hash = base58Encode(blockHashFromHeader(cp));
  if (hash !== cp.hash) throw new LightClientError(`the pinned checkpoint's header hashes to ${hash}, not ${cp.hash}`);
  if (base58Encode(blockProducersHash(cp.next_bps)) !== cp.inner_lite.next_bp_hash) throw new LightClientError("the pinned checkpoint's next_bps do not hash to its next_bp_hash");
  return {
    hash,
    height: cp.inner_lite.height,
    epochId: cp.inner_lite.epoch_id,
    nextEpochId: cp.inner_lite.next_epoch_id,
    innerLite: cp.inner_lite,
    epochBps: null,
    nextBps: cp.next_bps,
    approval: null,
    epochsWalked: 0,
  };
}

/**
 * One step of NEAR's light client (`validate_and_update_head` in the spec): accepts `lcb` as the new
 * head only if it is newer, in the trusted epoch or the next one, approved by more than 2/3 of that
 * epoch's producer stake, and its `next_bps` (required when it opens a new epoch) hash to its
 * `next_bp_hash`. Throws `LightClientError` otherwise.
 */
export function advanceHead(head: TrustedHead, lcb: LightClientBlock): TrustedHead {
  const at = `light client block ${lcb.inner_lite.height}`;
  if (lcb.inner_lite.height <= head.height) throw new LightClientError(`${at} is not after the trusted head ${head.height}`);
  const newEpoch = lcb.inner_lite.epoch_id === head.nextEpochId;
  if (!newEpoch && lcb.inner_lite.epoch_id !== head.epochId) throw new LightClientError(`${at} is in epoch ${lcb.inner_lite.epoch_id}, neither the trusted epoch nor the next one`);
  const producers = newEpoch ? head.nextBps : head.epochBps;
  if (!producers) throw new LightClientError(`${at} is in the pinned checkpoint's own epoch, whose producers are not pinned`);
  if (newEpoch && !lcb.next_bps) throw new LightClientError(`${at} opens epoch ${lcb.inner_lite.epoch_id} without next_bps`);
  const approval = checkApprovals(lcb, producers);
  if (!approval.ok) throw new LightClientError(`${at} is not approved by more than 2/3 of stake: ${approval.detail}`);
  if (lcb.next_bps && base58Encode(blockProducersHash(lcb.next_bps)) !== lcb.inner_lite.next_bp_hash) {
    throw new LightClientError(`${at}: next_bps do not hash to its next_bp_hash`);
  }
  return {
    hash: base58Encode(blockHashFromHeader(lcb)),
    height: lcb.inner_lite.height,
    epochId: lcb.inner_lite.epoch_id,
    nextEpochId: lcb.inner_lite.next_epoch_id,
    innerLite: lcb.inner_lite,
    epochBps: producers,
    nextBps: lcb.next_bps ?? head.nextBps,
    approval,
    epochsWalked: head.epochsWalked + (newEpoch ? 1 : 0),
  };
}

/** Where a light client keeps its walk between proofs. Create one per client with `createLightClientCache`. */
export interface LightClientCache {
  checkpoint?: string;
  head?: TrustedHead;
  queue?: Promise<unknown>;
}

export function createLightClientCache(): LightClientCache {
  return {};
}

/** Walks past every epoch since the checkpoint; a lying RPC can stall it, never forge a step. */
const MAX_STEPS = 100_000;
const defaultCaches = new WeakMap<RpcCall, LightClientCache>();

async function walk(rpc: RpcCall, cp: LightClientCheckpoint, cache: LightClientCache): Promise<TrustedHead> {
  if (cache.checkpoint !== cp.hash || !cache.head) {
    cache.head = headFromCheckpoint(cp);
    cache.checkpoint = cp.hash;
  }
  for (let i = 0; i < MAX_STEPS; i++) {
    const head: TrustedHead = cache.head;
    // Nodes older than about five epochs garbage-collect the block: `rpc` asks the archival endpoint then.
    const lcb = await rpc<LightClientBlock | null>('next_light_client_block', { last_block_hash: head.hash });
    // An empty answer: nothing final after the head yet.
    if (!lcb?.inner_lite) return head;
    const next = advanceHead(head, lcb);
    cache.head = next;
    // A block in the same epoch is the node's final head: the walk is done.
    if (next.epochId === head.epochId) return next;
  }
  throw new LightClientError(`the walk from the checkpoint did not reach a head in ${MAX_STEPS} steps`);
}

/**
 * Brings the light client up to a recent final head, from the cached head or the pinned checkpoint.
 * Walks run one at a time per cache, so concurrent proofs share one walk.
 */
export async function syncLightClient(rpc: RpcCall, cp: LightClientCheckpoint, cache: LightClientCache = createLightClientCache()): Promise<TrustedHead> {
  const run = (cache.queue ?? Promise.resolve()).then(() => walk(rpc, cp, cache));
  cache.queue = run.catch(() => undefined);
  return run;
}

export interface ProveOptions {
  /** The network whose pinned checkpoint to start from; asked of the RPC (`status`) when not given. */
  network?: Network;
  /** A checkpoint to trust instead of the pinned one. */
  checkpoint?: LightClientCheckpoint;
  /** Where the walk is kept between proofs; by default one per `rpc` function. */
  cache?: LightClientCache;
}

const CHAIN_CHECK = 'validator set chained from the pinned checkpoint';

/** The head's approved and total stake; a head without approvals (the checkpoint) reports its trusted set's total. */
function stakeOf(head: TrustedHead | undefined, cp: LightClientCheckpoint): { approvedStake: string; totalStake: string } {
  if (head?.approval) return { approvedStake: head.approval.approved.toString(), totalStake: head.approval.total.toString() };
  const total = (head?.nextBps ?? cp.next_bps).reduce((s, v) => s + BigInt(v.stake), 0n);
  return { approvedStake: '0', totalStake: total.toString() };
}

async function checkpointFor(rpc: RpcCall, opts: ProveOptions): Promise<LightClientCheckpoint> {
  if (opts.checkpoint) return opts.checkpoint;
  // Which chain the RPC serves only picks the checkpoint: a wrong answer fails the walk.
  const network = opts.network ?? (await rpc<{ chain_id: string }>('status', [])).chain_id;
  const cp = (CHECKPOINTS as Record<string, LightClientCheckpoint | undefined>)[network];
  if (!cp) throw new Error(`no pinned light client checkpoint for chain ${network}`);
  return cp;
}

/** Proves that `receiptId` (executed by `receiverId`) is in a final block and logged `expectedLog`. */
export async function proveReceipt(
  rpc: RpcCall,
  args: { receiptId: string; receiverId: string; expectedLog?: string },
  opts: ProveOptions = {},
): Promise<ProofResult> {
  const cp = await checkpointFor(rpc, opts);
  let cache = opts.cache ?? defaultCaches.get(rpc);
  if (!cache) defaultCaches.set(rpc, (cache = createLightClientCache()));
  const checkpoint = { network: cp.network, hash: cp.hash, height: cp.inner_lite.height };
  const checks: ProofCheck[] = [];

  let head: TrustedHead;
  try {
    head = await syncLightClient(rpc, cp, cache);
  } catch (e) {
    if (!(e instanceof LightClientError)) throw e;
    const last = cache.checkpoint === cp.hash ? cache.head : undefined;
    return {
      verified: false,
      checks: [{ name: CHAIN_CHECK, ok: false, detail: e.message }],
      head: { hash: last?.hash ?? cp.hash, height: last?.height ?? cp.inner_lite.height, ...stakeOf(last, cp) },
      block: { hash: '', height: 0, timestamp: 0 },
      receiptId: args.receiptId,
      executorId: args.receiverId,
      logs: [],
      checkpoint,
      epochsWalked: last?.epochsWalked ?? 0,
    };
  }
  const epochs = head.epochsWalked;
  checks.push({ name: CHAIN_CHECK, ok: true, detail: `${epochs} epoch${epochs === 1 ? '' : 's'} from checkpoint ${cp.inner_lite.height} (${cp.hash.slice(0, 8)}...)` });
  const approval = head.approval;
  checks.push({
    name: 'head approved by more than 2/3 of stake',
    ok: true,
    detail: approval ? approval.detail : 'the head is the pinned checkpoint',
  });

  const proof = await rpc<LightClientProof>('EXPERIMENTAL_light_client_proof', {
    type: 'receipt',
    receipt_id: args.receiptId,
    receiver_id: args.receiverId,
    light_client_head: head.hash,
  });
  const leaf = outcomeHash(proof.outcome_proof.id, proof.outcome_proof.outcome);
  const shardRoot = computeRootFromPath(proof.outcome_proof.proof, leaf);
  const blockOutcomeRoot = computeRootFromPath(proof.outcome_root_proof, sha256(shardRoot));
  const outcomeOk = base58Encode(blockOutcomeRoot) === proof.block_header_lite.inner_lite.outcome_root;
  checks.push({ name: 'outcome is in the block', ok: outcomeOk, detail: `outcome root ${base58Encode(blockOutcomeRoot)}` });

  const blockHash = blockHashFromHeader(proof.block_header_lite);
  const merkleRoot = computeRootFromPath(proof.block_proof, blockHash);
  const blockOk = base58Encode(merkleRoot) === head.innerLite.block_merkle_root;
  checks.push({ name: 'block is an ancestor of the head', ok: blockOk, detail: `block ${base58Encode(blockHash)}` });

  const idOk = proof.outcome_proof.id === args.receiptId && proof.outcome_proof.outcome.executor_id === args.receiverId;
  checks.push({ name: 'receipt and executor match', ok: idOk, detail: `${proof.outcome_proof.id} on ${proof.outcome_proof.outcome.executor_id}` });

  if (args.expectedLog !== undefined) {
    const has = proof.outcome_proof.outcome.logs.includes(args.expectedLog);
    checks.push({ name: 'event is in the outcome logs', ok: has, detail: has ? 'found' : 'missing' });
  }

  return {
    verified: checks.every((c) => c.ok),
    checks,
    head: { hash: head.hash, height: head.height, ...stakeOf(head, cp) },
    block: {
      hash: base58Encode(blockHash),
      height: proof.block_header_lite.inner_lite.height,
      timestamp: Math.floor(Number(BigInt(proof.block_header_lite.inner_lite.timestamp_nanosec) / 1_000_000n)),
    },
    receiptId: proof.outcome_proof.id,
    executorId: proof.outcome_proof.outcome.executor_id,
    logs: proof.outcome_proof.outcome.logs,
    checkpoint,
    epochsWalked: epochs,
  };
}

/** Finds the receipt of a transaction whose outcome logged an Attestra event with `match`. */
export async function findEventReceipt(
  rpc: RpcCall,
  txHash: string,
  senderId: string,
  match: (event: { event: string; data: Record<string, unknown>[] }, executorId: string) => boolean,
): Promise<{ receiptId: string; executorId: string; log: string } | null> {
  const tx = await rpc<{ receipts_outcome: Array<{ id: string; outcome: { logs: string[]; executor_id: string } }> }>(
    'EXPERIMENTAL_tx_status',
    { tx_hash: txHash, sender_account_id: senderId, wait_until: 'NONE' },
  );
  for (const r of tx.receipts_outcome) {
    for (const log of r.outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const ev = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (ev.standard === 'attestra' && match(ev, r.outcome.executor_id)) {
          return { receiptId: r.id, executorId: r.outcome.executor_id, log };
        }
      } catch {
        // not JSON; skip
      }
    }
  }
  return null;
}

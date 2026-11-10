/**
 * Light client proofs: prove that a receipt (and the event it logged) is part of a final NEAR
 * block, without trusting the indexer and with only light trust in the RPC.
 *
 * Steps, all computed locally:
 * 1. Take a recent light client block (`next_light_client_block`) as the head. Compute its hash
 *    from its fields and check that block producers holding more than 2/3 of the epoch's stake
 *    signed the approval for it (ed25519 over the Borsh approval message).
 * 2. Fetch `EXPERIMENTAL_light_client_proof` for the receipt against that head.
 * 3. Hash the execution outcome, walk the outcome proof to the shard outcome root, walk the outcome
 *    root proof to the block's outcome root and compare it with the block header; compute the
 *    block's hash from its header and walk the block proof to the head's block merkle root.
 * 4. Check the event line is among the outcome's logs.
 *
 * What it trusts: the epoch's ordered block producer list (`EXPERIMENTAL_validators_ordered`) comes
 * from the RPC; a full light client would follow `next_bp_hash` from epoch to epoch instead.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { BorshWriter, base58Decode, base58Encode, base64ToBytes } from './borsh';

export interface MerklePathItem {
  hash: string;
  direction: 'Left' | 'Right';
}

interface InnerLite {
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

export interface LightClientBlock {
  prev_block_hash: string;
  next_block_inner_hash: string;
  inner_lite: InnerLite;
  inner_rest_hash: string;
  next_bps: unknown[] | null;
  approvals_after_next: Array<string | null>;
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

function innerLiteBytes(i: InnerLite): Uint8Array {
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
export function blockHashFromHeader(h: { prev_block_hash: string; inner_rest_hash: string; inner_lite: InnerLite }): Uint8Array {
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

interface Validator {
  account_id: string;
  public_key: string;
  stake: string;
}

/** Checks the head's approvals; returns the approved and total stake. */
export function checkApprovals(lcb: LightClientBlock, producers: Validator[]): { ok: boolean; approved: bigint; total: bigint; detail: string } {
  const { message } = approvalMessage(lcb);
  let approved = 0n;
  let total = 0n;
  let bad = 0;
  producers.forEach((bp, i) => {
    total += BigInt(bp.stake);
    const sig = lcb.approvals_after_next[i];
    if (!sig) return;
    if (!bp.public_key.startsWith('ed25519:') || !sig.startsWith('ed25519:')) return;
    const valid = ed25519.verify(b58(sig.slice(8)), message, b58(bp.public_key.slice(8)));
    if (valid) approved += BigInt(bp.stake);
    else bad++;
  });
  const ok = total > 0n && approved * 3n > total * 2n;
  return { ok, approved, total, detail: `${approved}/${total} stake signed${bad ? `, ${bad} bad signatures ignored` : ''}` };
}

/** Proves that `receiptId` (executed by `receiverId`) is in a final block and logged `expectedLog`. */
export async function proveReceipt(
  rpc: RpcCall,
  args: { receiptId: string; receiverId: string; expectedLog?: string },
): Promise<ProofResult> {
  const checks: ProofCheck[] = [];
  const final = await rpc<{ header: { hash: string } }>('block', { finality: 'final' });
  // next_light_client_block answers {} when the serving node has nothing final after the given
  // block, which is common when it is asked from the latest final block: step back and ask again.
  let from = final.header.hash;
  let lcb = await rpc<LightClientBlock>('next_light_client_block', { last_block_hash: from });
  for (let i = 0; i < 5 && !lcb?.inner_lite; i++) {
    from = (await rpc<{ header: { prev_hash: string } }>('block', { block_id: from })).header.prev_hash;
    lcb = await rpc<LightClientBlock>('next_light_client_block', { last_block_hash: from });
  }
  if (!lcb?.inner_lite) throw new Error('the RPC returned no light client block');
  const { headHash } = approvalMessage(lcb);
  const headHashStr = base58Encode(headHash);
  const producers = await rpc<Validator[]>('EXPERIMENTAL_validators_ordered', [lcb.inner_lite.height]);
  const approvals = checkApprovals(lcb, producers);
  checks.push({ name: 'head approved by more than 2/3 of stake', ok: approvals.ok, detail: approvals.detail });

  const proof = await rpc<LightClientProof>('EXPERIMENTAL_light_client_proof', {
    type: 'receipt',
    receipt_id: args.receiptId,
    receiver_id: args.receiverId,
    light_client_head: headHashStr,
  });
  const leaf = outcomeHash(proof.outcome_proof.id, proof.outcome_proof.outcome);
  const shardRoot = computeRootFromPath(proof.outcome_proof.proof, leaf);
  const blockOutcomeRoot = computeRootFromPath(proof.outcome_root_proof, sha256(shardRoot));
  const outcomeOk = base58Encode(blockOutcomeRoot) === proof.block_header_lite.inner_lite.outcome_root;
  checks.push({ name: 'outcome is in the block', ok: outcomeOk, detail: `outcome root ${base58Encode(blockOutcomeRoot)}` });

  const blockHash = blockHashFromHeader(proof.block_header_lite);
  const merkleRoot = computeRootFromPath(proof.block_proof, blockHash);
  const blockOk = base58Encode(merkleRoot) === lcb.inner_lite.block_merkle_root;
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
    head: { hash: headHashStr, height: lcb.inner_lite.height, approvedStake: approvals.approved.toString(), totalStake: approvals.total.toString() },
    block: {
      hash: base58Encode(blockHash),
      height: proof.block_header_lite.inner_lite.height,
      timestamp: Math.floor(Number(BigInt(proof.block_header_lite.inner_lite.timestamp_nanosec) / 1_000_000n)),
    },
    receiptId: proof.outcome_proof.id,
    executorId: proof.outcome_proof.outcome.executor_id,
    logs: proof.outcome_proof.outcome.logs,
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

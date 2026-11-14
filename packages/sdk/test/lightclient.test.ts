import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { base58Decode, base58Encode } from '../src/borsh';
import { CHECKPOINTS, type LightClientCheckpoint } from '../src/checkpoints';
import {
  blockHashFromHeader,
  blockProducersHash,
  createLightClientCache,
  headFromCheckpoint,
  proveReceipt,
  type LightClientBlock,
  type ProofResult,
} from '../src/lightclient';

/**
 * Recorded from testnet (archival RPC): a checkpoint three epochs before the head, every
 * `next_light_client_block` answer of the walk keyed by the hash it was asked from, and the
 * receipt proof against the head the walk ended at.
 */
const fx = JSON.parse(readFileSync(new URL('./fixtures/light-client.json', import.meta.url), 'utf8')) as {
  receipt: { receiptId: string; receiverId: string; expectedLog: string };
  checkpoint: LightClientCheckpoint;
  head: string;
  walk: Record<string, LightClientBlock>;
  proof: unknown;
};

const CHAIN = 'validator set chained from the pinned checkpoint';
/** Walk steps in the order the light client asks for them. */
const order = (() => {
  const out: string[] = [];
  let at = fx.checkpoint.hash;
  while (fx.walk[at]) {
    out.push(at);
    at = base58Encode(blockHashFromHeader(fx.walk[at]));
  }
  return out;
})();

/** The producers that must approve the block answered at `step`: those its epoch was opened with. */
function producersAt(step: number) {
  const epoch = fx.walk[order[step]].inner_lite.epoch_id;
  const earlier = [fx.checkpoint, ...order.slice(0, step).map((h) => fx.walk[h])];
  return earlier.reverse().find((b) => b.inner_lite.next_epoch_id === epoch)!.next_bps!;
}

type Mutate = (method: string, params: any, result: any) => any;

function fixtureRpc(mutate?: Mutate, calls?: string[]) {
  return async <T>(method: string, params: any): Promise<T> => {
    calls?.push(method);
    let r: unknown;
    if (method === 'next_light_client_block') r = structuredClone(fx.walk[params.last_block_hash] ?? {});
    else if (method === 'EXPERIMENTAL_light_client_proof') r = structuredClone(fx.proof);
    else if (method === 'status') r = { chain_id: 'testnet' };
    else throw new Error(`unexpected RPC ${method}`);
    return (mutate ? mutate(method, params, r) : r) as T;
  };
}

/** Rewrites the answer to the `step`th walk call. */
const atStep = (step: number, f: (lcb: any) => void): Mutate => (m, p, r) => {
  if (m === 'next_light_client_block' && p.last_block_hash === order[step]) f(r);
  return r;
};

const prove = (mutate?: Mutate, opts: Parameters<typeof proveReceipt>[2] = {}) =>
  proveReceipt(fixtureRpc(mutate), fx.receipt, { checkpoint: fx.checkpoint, cache: createLightClientCache(), ...opts });

const chainCheck = (res: ProofResult) => res.checks.find((c) => c.name === CHAIN);

describe('light client proof (recorded from testnet)', () => {
  it('chains the validator set from the checkpoint and verifies every step', async () => {
    const res = await prove();
    expect(res.checks.map((c) => [c.name, c.ok])).toEqual([
      [CHAIN, true],
      ['head approved by more than 2/3 of stake', true],
      ['outcome is in the block', true],
      ['block is an ancestor of the head', true],
      ['receipt and executor match', true],
      ['event is in the outcome logs', true],
    ]);
    expect(res.verified).toBe(true);
    expect(res.head.hash).toBe(fx.head);
    expect(res.epochsWalked).toBe(3);
    expect(res.checkpoint).toEqual({ network: 'testnet', hash: fx.checkpoint.hash, height: fx.checkpoint.inner_lite.height });
    expect(chainCheck(res)?.detail).toContain('3 epochs from checkpoint');
    expect(BigInt(res.head.approvedStake) * 3n > BigInt(res.head.totalStake) * 2n).toBe(true);
  });

  it('never asks the RPC for the validator set', async () => {
    const calls: string[] = [];
    await proveReceipt(fixtureRpc(undefined, calls), fx.receipt, { checkpoint: fx.checkpoint, cache: createLightClientCache() });
    expect(calls).not.toContain('EXPERIMENTAL_validators_ordered');
    expect(calls.filter((m) => m === 'next_light_client_block')).toHaveLength(order.length);
  });

  it('caches the walk per client: a second proof asks only for a newer head', async () => {
    const calls: string[] = [];
    const cache = createLightClientCache();
    const rpc = fixtureRpc(undefined, calls);
    await proveReceipt(rpc, fx.receipt, { checkpoint: fx.checkpoint, cache });
    calls.length = 0;
    const again = await proveReceipt(rpc, fx.receipt, { checkpoint: fx.checkpoint, cache });
    expect(again.verified).toBe(true);
    expect(again.epochsWalked).toBe(3);
    expect(calls).toEqual(['next_light_client_block', 'EXPERIMENTAL_light_client_proof']);
  });

  it('shares one walk between concurrent proofs', async () => {
    const calls: string[] = [];
    const cache = createLightClientCache();
    const rpc = fixtureRpc(undefined, calls);
    const [a, b] = await Promise.all([proveReceipt(rpc, fx.receipt, { checkpoint: fx.checkpoint, cache }), proveReceipt(rpc, fx.receipt, { checkpoint: fx.checkpoint, cache })]);
    expect(a.verified && b.verified).toBe(true);
    expect(calls.filter((m) => m === 'next_light_client_block')).toHaveLength(order.length + 1);
  });

  it('starts from the pinned testnet checkpoint when the network is asked of the RPC', async () => {
    const res = await proveReceipt(fixtureRpc(), fx.receipt);
    expect(res.checkpoint.hash).toBe(CHECKPOINTS.testnet.hash);
    // The pinned checkpoint is a step of the recorded walk: one epoch to the same head.
    expect(res.verified).toBe(true);
    expect(res.epochsWalked).toBe(1);
  });

  it('fails when a walk block carries a tampered next_bps', async () => {
    const res = await prove(atStep(0, (b) => (b.next_bps[0].stake = (BigInt(b.next_bps[0].stake) * 10n).toString())));
    expect(res.verified).toBe(false);
    expect(chainCheck(res)?.ok).toBe(false);
    expect(chainCheck(res)?.detail).toContain('next_bps do not hash to its next_bp_hash');
    // The site divides by the total stake: a failed walk still reports a non-zero one.
    expect(BigInt(res.head.totalStake) > 0n).toBe(true);
  });

  it('fails when a forged next_bps comes with a matching next_bp_hash (the block hash changes, the approvals no longer match)', async () => {
    const attacker = base58Encode(new Uint8Array(32).fill(7));
    const res = await prove(
      atStep(1, (b) => {
        b.next_bps = b.next_bps.map((v: any) => ({ ...v, public_key: `ed25519:${attacker}` }));
        b.inner_lite.next_bp_hash = base58Encode(blockProducersHash(b.next_bps));
      }),
    );
    expect(res.verified).toBe(false);
    expect(chainCheck(res)?.detail).toContain('is not approved by more than 2/3 of stake');
  });

  it('fails when the head approvals fall to 2/3 of stake or below', async () => {
    const last = order.length - 1;
    const res = await prove(
      atStep(last, (b) => {
        // Drop the largest signers until at most 2/3 of the epoch's stake is left signed.
        const bps = producersAt(last);
        const total = bps.reduce((s, v) => s + BigInt(v.stake), 0n);
        let signed = bps.reduce((s, v, i) => (b.approvals_after_next[i] ? s + BigInt(v.stake) : s), 0n);
        const byStake = bps.map((v, i) => i).sort((x, y) => (BigInt(bps[y].stake) > BigInt(bps[x].stake) ? 1 : -1));
        for (const i of byStake) {
          if (signed * 3n <= total * 2n) break;
          if (!b.approvals_after_next[i]) continue;
          b.approvals_after_next[i] = null;
          signed -= BigInt(bps[i].stake);
        }
        expect(b.approvals_after_next.some(Boolean)).toBe(true);
      }),
    );
    expect(res.verified).toBe(false);
    expect(chainCheck(res)?.detail).toContain('is not approved by more than 2/3 of stake');
  });

  it('fails when an approval signature is forged', async () => {
    const res = await prove(
      atStep(0, (b) => {
        b.approvals_after_next = b.approvals_after_next.map((s: string | null) => {
          if (!s) return s;
          const sig = base58Decode(s.slice(8));
          sig[0] ^= 1;
          return `ed25519:${base58Encode(sig)}`;
        });
      }),
    );
    expect(res.verified).toBe(false);
    expect(chainCheck(res)?.detail).toMatch(/bad signatures ignored/);
  });

  it('fails when a block skips an epoch or goes backwards', async () => {
    const skip = await prove((m, p, r) => (m === 'next_light_client_block' && p.last_block_hash === order[0] ? structuredClone(fx.walk[order[1]]) : r));
    expect(skip.verified).toBe(false);
    expect(chainCheck(skip)?.detail).toContain('neither the trusted epoch nor the next one');
    const back = await prove(atStep(1, (b) => (b.inner_lite.height = fx.checkpoint.inner_lite.height)));
    expect(back.verified).toBe(false);
  });

  it('fails with a wrong checkpoint: fields that do not hash to the pinned hash', async () => {
    const cp = structuredClone(fx.checkpoint);
    cp.inner_lite.next_epoch_id = cp.inner_lite.epoch_id;
    const res = await prove(undefined, { checkpoint: cp });
    expect(res.verified).toBe(false);
    expect(chainCheck(res)?.detail).toContain("pinned checkpoint's header hashes to");
  });

  it('fails with a wrong checkpoint: next_bps that do not match its next_bp_hash', async () => {
    const cp = structuredClone(fx.checkpoint);
    cp.next_bps = cp.next_bps.slice(1);
    const res = await prove(undefined, { checkpoint: cp });
    expect(res.verified).toBe(false);
    expect(chainCheck(res)?.detail).toContain('do not hash to its next_bp_hash');
  });

  it('fails with a wrong checkpoint: a self-consistent forged validator set', async () => {
    // An attacker's checkpoint: fake producers, re-hashed so it is internally consistent. The real
    // chain's next block is not signed by them.
    const cp = structuredClone(fx.checkpoint);
    const fake = base58Encode(new Uint8Array(32).fill(9));
    cp.next_bps = cp.next_bps.map((v) => ({ ...v, public_key: `ed25519:${fake}` }));
    cp.inner_lite.next_bp_hash = base58Encode(blockProducersHash(cp.next_bps));
    cp.hash = base58Encode(blockHashFromHeader(cp));
    const rpc = fixtureRpc((m, p, r) => (m === 'next_light_client_block' && p.last_block_hash === cp.hash ? structuredClone(fx.walk[order[0]]) : r));
    const res = await proveReceipt(rpc, fx.receipt, { checkpoint: cp, cache: createLightClientCache() });
    expect(res.verified).toBe(false);
    expect(chainCheck(res)?.detail).toContain('is not approved by more than 2/3 of stake');
  });

  it('fails with the checkpoint of another network', async () => {
    const res = await prove(undefined, { checkpoint: CHECKPOINTS.mainnet });
    expect(res.verified).toBe(false);
    expect(res.checks.find((c) => c.name === 'block is an ancestor of the head')?.ok).toBe(false);
  });

  it('keeps verified progress when a later step fails', async () => {
    const cache = createLightClientCache();
    const bad = await prove(atStep(2, (b) => (b.approvals_after_next = b.approvals_after_next.map(() => null))), { cache });
    expect(bad.verified).toBe(false);
    expect(bad.epochsWalked).toBe(2);
    const good = await prove(undefined, { cache });
    expect(good.verified).toBe(true);
    expect(good.epochsWalked).toBe(3);
  });

  it('fails when a log is altered', async () => {
    const res = await prove((m, _p, r) => {
      if (m === 'EXPERIMENTAL_light_client_proof') r.outcome_proof.outcome.logs[0] = r.outcome_proof.outcome.logs[0] + ' ';
      return r;
    });
    expect(res.verified).toBe(false);
    expect(res.checks.find((c) => c.name === 'outcome is in the block')?.ok).toBe(false);
  });

  it('fails when the expected event is not logged', async () => {
    const res = await proveReceipt(fixtureRpc(), { ...fx.receipt, expectedLog: 'EVENT_JSON:{}' }, { checkpoint: fx.checkpoint, cache: createLightClientCache() });
    expect(res.verified).toBe(false);
  });
});

describe('pinned checkpoints', () => {
  for (const network of ['testnet', 'mainnet'] as const) {
    it(`${network}: the fields hash to the pinned block hash and next_bp_hash`, () => {
      const cp = CHECKPOINTS[network];
      expect(cp.network).toBe(network);
      const head = headFromCheckpoint(cp);
      expect(head.hash).toBe(cp.hash);
      expect(base58Encode(blockProducersHash(cp.next_bps))).toBe(cp.inner_lite.next_bp_hash);
      expect(cp.next_bps.length).toBeGreaterThan(0);
    });
  }
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { proveReceipt } from '../src/lightclient';

const fx = JSON.parse(readFileSync(new URL('./fixtures/light-client.json', import.meta.url), 'utf8'));

function fixtureRpc(mutate?: (method: string, result: any) => any) {
  return async <T>(method: string, _params: unknown): Promise<T> => {
    const r = structuredClone(
      method === 'block' ? fx.final : method === 'next_light_client_block' ? fx.lcb : method === 'EXPERIMENTAL_validators_ordered' ? fx.producers : fx.proof,
    );
    return (mutate ? mutate(method, r) : r) as T;
  };
}

describe('light client proof (recorded from testnet)', () => {
  it('verifies every step', async () => {
    const res = await proveReceipt(fixtureRpc(), fx.receipt);
    expect(res.checks.every((c) => c.ok)).toBe(true);
    expect(res.verified).toBe(true);
    expect(BigInt(res.head.approvedStake) * 3n > BigInt(res.head.totalStake) * 2n).toBe(true);
  });

  it('steps back when the RPC has no light client block after the final head', async () => {
    let asked = 0;
    const base = fixtureRpc();
    const rpc = async <T>(method: string, params: unknown): Promise<T> => {
      if (method === 'next_light_client_block' && asked++ === 0) return {} as T;
      if (method === 'block' && (params as { block_id?: string }).block_id) return { header: { hash: 'older', prev_hash: 'older' } } as T;
      return base<T>(method, params);
    };
    const res = await proveReceipt(rpc, fx.receipt);
    expect(asked).toBe(2);
    expect(res.verified).toBe(true);
  });

  it('fails when a log is altered', async () => {
    const res = await proveReceipt(
      fixtureRpc((m, r) => {
        if (m === 'EXPERIMENTAL_light_client_proof') r.outcome_proof.outcome.logs[0] = r.outcome_proof.outcome.logs[0] + ' ';
        return r;
      }),
      fx.receipt,
    );
    expect(res.verified).toBe(false);
    expect(res.checks.find((c) => c.name === 'outcome is in the block')?.ok).toBe(false);
  });

  it('fails when the head approvals are forged', async () => {
    const res = await proveReceipt(
      fixtureRpc((m, r) => {
        if (m === 'next_light_client_block') r.approvals_after_next = r.approvals_after_next.map(() => null);
        return r;
      }),
      fx.receipt,
    );
    expect(res.verified).toBe(false);
  });

  it('fails when the expected event is not logged', async () => {
    const res = await proveReceipt(fixtureRpc(), { ...fx.receipt, expectedLog: 'EVENT_JSON:{}' });
    expect(res.verified).toBe(false);
  });
});

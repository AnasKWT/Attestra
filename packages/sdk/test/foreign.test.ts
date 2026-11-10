import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttestraClient } from '../src/client';
import { fetchEvmLog } from '../src/verdicts';

const respond = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('view errors', () => {
  it('surfaces the panic of a view that fails inside the contract', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        jsonrpc: '2.0',
        id: 1,
        result: { error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "Failed to deserialize input from JSON. Error: `missing field removed`" })', logs: [], block_height: 1 },
      }),
    );
    const c = new AttestraClient({ network: 'testnet' });
    const r = await c.attestForeignEvent({ chain: 'base', txId: '0x11', logIndex: 0, log: {} as never });
    expect(r.success).toBe(false);
    expect(r.error?.message).toContain('missing field removed');
  });
});

describe('fetchEvmLog', () => {
  const receipt = {
    transactionIndex: '0x3',
    blockHash: '0xAB',
    blockNumber: '0x10',
    logs: [
      { logIndex: '0x4', address: '0xDEAD', topics: ['0xC0FFEE'], data: '0x0102', removed: false },
      { logIndex: '0x5', address: '0xBEEF', topics: [], data: '0x', removed: false },
    ],
  };

  it("shapes the receipt's log as the contract's EvmLog", async () => {
    const f = respond({ jsonrpc: '2.0', id: 1, result: receipt });
    vi.stubGlobal('fetch', f);
    const log = await fetchEvmLog('testnet', 'base', '0x99', 4);
    expect(log).toEqual({
      removed: false,
      log_index: 4,
      transaction_index: 3,
      transaction_hash: '99',
      block_hash: 'ab',
      block_number: 16,
      address: 'dead',
      data: '0x0102',
      topics: ['c0ffee'],
    });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://sepolia.base.org');
  });

  it('names the indexes a transaction has when the asked one is missing', async () => {
    vi.stubGlobal('fetch', respond({ jsonrpc: '2.0', id: 1, result: receipt }));
    await expect(fetchEvmLog('testnet', 'base', '0x99', 0)).rejects.toThrow('it has 4, 5');
  });

  it('refuses a chain the MPC network does not read', async () => {
    await expect(fetchEvmLog('testnet', 'solana', '0x99', 0)).rejects.toThrow('unknown chain solana');
  });
});

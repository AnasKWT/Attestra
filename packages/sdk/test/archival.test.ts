import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttestraClient } from '../src/client';
import { NETWORKS } from '../src/config';

const rpcError = (name: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name }, message: 'Server error', data: 'gone' } }));
const rpcResult = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));

/** Every regular endpoint answers `regular`; the archival endpoint answers with a result. */
function stub(regular: () => Response) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(url);
    return url === NETWORKS.testnet.archivalRpcUrl ? rpcResult({ from: 'archival' }) : regular();
  });
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe('AttestraClient.rpc', () => {
  it.each(['UNKNOWN_TRANSACTION', 'UNKNOWN_TRANSACTION_OR_RECEIPT'])('asks the archival endpoint when regular nodes answer %s', async (name) => {
    const asked = stub(() => rpcError(name));
    const out = await new AttestraClient({ network: 'testnet' }).rpc('EXPERIMENTAL_tx_status', {});
    expect(out).toEqual({ from: 'archival' });
    expect(asked.at(0)).toBe(NETWORKS.testnet.rpcUrls[0]);
    expect(asked.at(-1)).toBe(NETWORKS.testnet.archivalRpcUrl);
  });

  it('keeps any other RPC error final and never asks the archival endpoint', async () => {
    const asked = stub(() => rpcError('UNKNOWN_ACCOUNT'));
    await expect(new AttestraClient({ network: 'testnet' }).rpc('query', {})).rejects.toThrow('Server error');
    expect(asked).toEqual([NETWORKS.testnet.rpcUrls[0]]);
  });
});

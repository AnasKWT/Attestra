/** Public RPCs of the EVM chains the NEAR MPC network can read (test networks on testnet). */

import { NETWORK } from './config';

export const EVM_CHAINS = {
  testnet: {
    base: { name: 'Base Sepolia', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org' },
    arbitrum: { name: 'Arbitrum Sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc', explorer: 'https://sepolia.arbiscan.io' },
    polygon: { name: 'Polygon Amoy', rpc: 'https://rpc-amoy.polygon.technology', explorer: 'https://amoy.polygonscan.com' },
    bnb: { name: 'BNB testnet', rpc: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545', explorer: 'https://testnet.bscscan.com' },
    avalanche: { name: 'Avalanche Fuji', rpc: 'https://api.avax-test.network/ext/bc/C/rpc', explorer: 'https://testnet.snowtrace.io' },
  },
  mainnet: {
    ethereum: { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io' },
    base: { name: 'Base', rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org' },
    arbitrum: { name: 'Arbitrum One', rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io' },
    polygon: { name: 'Polygon', rpc: 'https://polygon-rpc.com', explorer: 'https://polygonscan.com' },
    bnb: { name: 'BNB Chain', rpc: 'https://bsc-dataseed.bnbchain.org', explorer: 'https://bscscan.com' },
    avalanche: { name: 'Avalanche C-Chain', rpc: 'https://api.avax.network/ext/bc/C/rpc', explorer: 'https://snowtrace.io' },
  },
} as const;

export const chainsHere = () => EVM_CHAINS[NETWORK] as Record<string, { name: string; rpc: string; explorer: string }>;

/** Reads one log of a transaction receipt and shapes it as the verdicts contract's EvmLog. */
export async function fetchEvmLog(chain: string, txHash: string, logIndex: number) {
  const c = chainsHere()[chain];
  if (!c) throw new Error(`unknown chain ${chain}`);
  const res = await fetch(c.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }) });
  const j = (await res.json()) as { result?: { logs: Array<Record<string, string | string[] | boolean>>; transactionIndex: string; blockHash: string; blockNumber: string } };
  if (!j.result) throw new Error('transaction not found on that chain');
  const log = j.result.logs.find((l) => parseInt(String(l.logIndex), 16) === logIndex);
  if (!log) throw new Error(`the transaction has no log with index ${logIndex}; it has ${j.result.logs.map((l) => parseInt(String(l.logIndex), 16)).join(', ') || 'none'}`);
  const strip = (h: string) => h.replace(/^0x/, '').toLowerCase();
  return {
    removed: Boolean(log.removed),
    log_index: logIndex,
    transaction_index: parseInt(j.result.transactionIndex, 16),
    transaction_hash: strip(txHash),
    block_hash: strip(j.result.blockHash),
    block_number: parseInt(j.result.blockNumber, 16),
    address: strip(String(log.address)),
    data: String(log.data),
    topics: (log.topics as string[]).map(strip),
  };
}

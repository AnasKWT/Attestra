/**
 * Shapes and digests of the verdicts contract (contracts/verdicts):
 * - AI verdicts signed by the private-check enclave,
 * - foreign-chain events verified by the NEAR MPC network,
 * - wallet links proven by the foreign wallet's own signature.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { BorshWriter } from './borsh';
import { uidBytes } from './uid';

export interface AiVerdict {
  request_id: string;
  rule_id: string;
  subject: string;
  result: boolean;
  /** SHA-256 (hex) of the exact NEAR AI request body; the evidence itself is never stored. */
  evidence_hash: string;
  model: string;
  issued_at: number;
  expires_at: number;
}

/** sha256(borsh(("attestra:verdict:v1", request_id, rule_id, subject, result, evidence_hash, model, issued_at, expires_at))) */
export function verdictDigest(v: AiVerdict): Uint8Array {
  const w = new BorshWriter()
    .string('attestra:verdict:v1')
    .fixed(uidBytes(v.request_id))
    .string(v.rule_id)
    .string(v.subject)
    .bool(v.result)
    .fixed(uidBytes(v.evidence_hash))
    .string(v.model)
    .u64(v.issued_at)
    .u64(v.expires_at);
  return sha256(w.toBytes());
}

/**
 * EVM chain ids the verdicts contract maps foreign events to (CAIP-2 `eip155:<id>`). The testnet
 * MPC network reads the test networks (Base Sepolia and so on), so testnet uses their ids.
 */
export const foreignChainIdsTestnet: Record<string, number> = {
  ethereum: 11155111,
  base: 84532,
  arbitrum: 421614,
  polygon: 80002,
  bnb: 97,
  avalanche: 43113,
};

export const foreignChainIds: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  polygon: 137,
  bnb: 56,
  avalanche: 43114,
};

/** Public RPCs and explorers of the EVM chains the NEAR MPC network reads (test networks on testnet). */
export const EVM_CHAINS: Record<'testnet' | 'mainnet', Record<string, { name: string; rpc: string; explorer: string }>> = {
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
};

/** A log in the verdicts contract's `EvmLog` shape: hex without `0x`, except `data` as the RPC returns it. */
export interface EvmLog {
  removed: boolean;
  log_index: number;
  transaction_index: number;
  transaction_hash: string;
  block_hash: string;
  block_number: number;
  address: string;
  data: string;
  topics: string[];
}

/** Reads one log of a transaction receipt from the chain's public RPC (or `rpcUrl`) and shapes it as an `EvmLog`. */
export async function fetchEvmLog(network: 'testnet' | 'mainnet', chain: string, txHash: string, logIndex: number, rpcUrl?: string): Promise<EvmLog> {
  const url = rpcUrl ?? EVM_CHAINS[network][chain]?.rpc;
  if (!url) throw new Error(`unknown chain ${chain}; one of ${Object.keys(EVM_CHAINS[network]).join(', ')}`);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }) });
  const j = (await res.json()) as { result?: { logs: Array<Record<string, string | string[] | boolean>>; transactionIndex: string; blockHash: string; blockNumber: string } };
  if (!j.result) throw new Error(`transaction ${txHash} not found on ${chain}`);
  const index = (l: Record<string, unknown>) => parseInt(String(l.logIndex), 16);
  const log = j.result.logs.find((l) => index(l) === logIndex);
  if (!log) throw new Error(`the transaction has no log with index ${logIndex}; it has ${j.result.logs.map(index).join(', ') || 'none'}`);
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

export const SOLANA_MAINNET_REF = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** The CAIP-10 id the contract records for a linked wallet. */
export function walletCaip10(chain: 'eip155' | 'solana', address: string): string {
  return chain === 'eip155' ? `eip155:1:${address.toLowerCase()}` : `solana:${SOLANA_MAINNET_REF}:${address}`;
}

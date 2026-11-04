/**
 * Network settings. One switch (`network`) selects testnet or mainnet everywhere; every contract
 * id derives from the deployment root unless overridden.
 */

import type { Network } from './types';

export interface ContractIds {
  schemas: string;
  attestations: string;
  verdicts: string;
  credentials: string;
  staking: string;
  token: string;
  resolvers: {
    whitelist: string;
    fee: string;
    tokenGated: string;
    tokenReward: string;
    pipeline: string;
  };
}

export interface NetworkConfig {
  network: Network;
  /** Account the contracts live under. */
  root: string;
  rpcUrls: string[];
  archivalRpcUrl: string;
  explorerUrl: string;
  contracts: ContractIds;
  /** NEAR Chain Signatures MPC signer. */
  mpc: string;
  /** NEP-141 used for x402 payments: the test token on testnet, native USDC on mainnet. */
  paymentToken: string;
  paymentTokenDecimals: number;
  /** Wrapped NEAR. */
  wrapNear: string;
  /** OutLayer contract (TEE compute). */
  outlayer: string;
  outlayerApi: string;
  /** FastNEAR transactions API. */
  txApiUrl: string;
}

export function contractIdsFor(root: string): ContractIds {
  return {
    schemas: `schemas.${root}`,
    attestations: `attestations.${root}`,
    verdicts: `verdicts.${root}`,
    credentials: `credentials.${root}`,
    staking: `staking.${root}`,
    token: `token.${root}`,
    resolvers: {
      whitelist: `whitelist.${root}`,
      fee: `fee.${root}`,
      tokenGated: `gated.${root}`,
      tokenReward: `reward.${root}`,
      pipeline: `pipeline.${root}`,
    },
  };
}

export const DEFAULT_ROOTS: Record<Network, string> = {
  testnet: 'attestra.testnet',
  mainnet: 'attestra.near',
};

const TESTNET: NetworkConfig = {
  network: 'testnet',
  root: DEFAULT_ROOTS.testnet,
  rpcUrls: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'],
  archivalRpcUrl: 'https://archival-rpc.testnet.fastnear.com',
  explorerUrl: 'https://testnet.nearblocks.io',
  contracts: contractIdsFor(DEFAULT_ROOTS.testnet),
  mpc: 'v1.signer-prod.testnet',
  paymentToken: `token.${DEFAULT_ROOTS.testnet}`,
  paymentTokenDecimals: 18,
  wrapNear: 'wrap.testnet',
  outlayer: 'outlayer.testnet',
  outlayerApi: 'https://testnet-api.outlayer.ai',
  txApiUrl: 'https://tx.test.fastnear.com',
};

// #mainnet: the plan in MAINNET.md; nothing is deployed there yet.
const MAINNET: NetworkConfig = {
  network: 'mainnet',
  root: DEFAULT_ROOTS.mainnet,
  rpcUrls: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com', 'https://rpc.mainnet.near.org'],
  archivalRpcUrl: 'https://archival-rpc.mainnet.fastnear.com',
  explorerUrl: 'https://nearblocks.io',
  contracts: contractIdsFor(DEFAULT_ROOTS.mainnet),
  mpc: 'v1.signer',
  // Circle's native USDC on NEAR.
  paymentToken: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  paymentTokenDecimals: 6,
  wrapNear: 'wrap.near',
  outlayer: 'outlayer.near',
  outlayerApi: 'https://api.outlayer.ai',
  txApiUrl: 'https://tx.main.fastnear.com',
};

export const NETWORKS: Record<Network, NetworkConfig> = { testnet: TESTNET, mainnet: MAINNET };

/** NEAR AI Cloud (OpenAI-compatible, verifiable models run in TEEs). */
export const NEAR_AI_BASE_URL = 'https://cloud-api.near.ai/v1';
export const NEAR_AI_VERIFY_URL = 'https://cloud.near.ai/verify';

export function resolveNetwork(network: Network = 'testnet', overrides: { root?: string; rpcUrl?: string } = {}): NetworkConfig {
  const base = NETWORKS[network];
  if (!base) throw new Error(`unknown network ${network}`);
  const root = overrides.root ?? base.root;
  return {
    ...base,
    root,
    contracts: root === base.root ? base.contracts : contractIdsFor(root),
    paymentToken: network === 'testnet' && root !== base.root ? `token.${root}` : base.paymentToken,
    rpcUrls: overrides.rpcUrl ? [overrides.rpcUrl, ...base.rpcUrls] : base.rpcUrls,
  };
}

export function explorerTxUrl(network: Network, txHash: string): string {
  return `${NETWORKS[network].explorerUrl}/txns/${txHash}`;
}

export function explorerAccountUrl(network: Network, accountId: string): string {
  return `${NETWORKS[network].explorerUrl}/address/${accountId}`;
}

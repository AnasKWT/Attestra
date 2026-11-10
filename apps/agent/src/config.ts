/** Agent settings from the environment; every value has a working testnet default or a clear idle mode. */

import { resolveNetwork, type Network } from '@attestra/sdk';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const network = (env.NEAR_NETWORK ?? 'testnet') as Network;
  const net = resolveNetwork(network, { root: env.ATTESTRA_ROOT || undefined, rpcUrl: env.RPC_URL || undefined });
  return {
    network,
    net,
    port: Number(env.AGENT_PORT ?? env.PORT ?? 5300),
    publicUrl: (env.AGENT_PUBLIC_URL ?? `http://localhost:${env.AGENT_PORT ?? env.PORT ?? 5300}`).replace(/\/+$/, ''),
    indexerUrl: env.INDEXER_URL ?? 'http://localhost:5100',
    nearAiKey: env.NEARAI_API_KEY || undefined,
    model: env.NEARAI_MODEL || undefined,
    accountId: env.AGENT_ACCOUNT_ID || `agent.${net.root}`,
    privateKey: env.AGENT_PRIVATE_KEY || undefined,
    /** ed25519 secret key the private-check verdicts are signed with in local mode. */
    checkerKey: env.CHECKER_PRIVATE_KEY || undefined,
    /** local: this process checks; outlayer: the checker/ build checks inside an OutLayer TEE. */
    checkerMode: checkerMode(env.CHECKER_MODE),
    /** The published checker wasm and its sha256 (outlayer mode). */
    outlayerWasmUrl: env.OUTLAYER_WASM_URL || undefined,
    outlayerWasmHash: env.OUTLAYER_WASM_HASH?.toLowerCase() || undefined,
    /** The profile of the agent account's secrets row for that wasm hash (NEARAI_API_KEY, GITHUB_TOKEN). */
    outlayerSecretsProfile: env.OUTLAYER_SECRETS_PROFILE || 'default',
    priceClaim: env.X402_PRICE_CLAIM ?? (network === 'mainnet' ? '10000' : '1000000000000000000'),
    priceAgent: env.X402_PRICE_AGENT ?? (network === 'mainnet' ? '20000' : '2000000000000000000'),
    githubToken: env.GITHUB_TOKEN || undefined,
    /** The Agent Market listing's `aat_` token; without it the market worker stays off. */
    marketToken: env.MARKET_AGENT_TOKEN || undefined,
    marketUrl: env.MARKET_URL || 'https://market.near.ai',
  };
}

function checkerMode(value: string | undefined): 'local' | 'outlayer' {
  const mode = value || 'local';
  if (mode !== 'local' && mode !== 'outlayer') throw new Error(`CHECKER_MODE must be local or outlayer, not ${mode}`);
  return mode;
}

export type AgentConfig = ReturnType<typeof loadConfig>;

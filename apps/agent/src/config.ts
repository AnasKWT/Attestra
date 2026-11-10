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
    /** ed25519 secret key the private-check verdicts are signed with when no OutLayer enclave is configured. */
    checkerKey: env.CHECKER_PRIVATE_KEY || undefined,
    checkerMode: (env.CHECKER_MODE ?? 'local') as 'local' | 'outlayer',
    outlayerProject: env.OUTLAYER_PROJECT || undefined,
    outlayerPaymentKey: env.OUTLAYER_PAYMENT_KEY || undefined,
    priceClaim: env.X402_PRICE_CLAIM ?? (network === 'mainnet' ? '10000' : '1000000000000000000'),
    priceAgent: env.X402_PRICE_AGENT ?? (network === 'mainnet' ? '20000' : '2000000000000000000'),
    githubToken: env.GITHUB_TOKEN || undefined,
  };
}

export type AgentConfig = ReturnType<typeof loadConfig>;

/** Agent settings from the environment; every value has a working testnet default or a clear idle mode. */

import { parseRate, resolveNetwork, trustProxySetting, type Network, type Rate } from 'attestra';

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
    /** Client addresses come from the first `X-Forwarded-For` hop (on behind Caddy in compose.yaml). */
    trustProxy: trustProxySetting(env.TRUST_PROXY),
    rates: rateSettings(env),
  };
}

/**
 * Rate limits (see `parseRate`: `5/10m`, `0` turns one off). Per client address unless named
 * otherwise; the daily budgets count every client together and start again at midnight UTC.
 */
function rateSettings(env: NodeJS.ProcessEnv) {
  const rate = (name: string, fallback: string): Rate => {
    try {
      return parseRate(env[name], fallback);
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  };
  return {
    checkIp: rate('AGENT_RATE_CHECK_IP', '5/10m'),
    /** Per subject account, counted once the subject's signature verified. */
    checkSubject: rate('AGENT_RATE_CHECK_SUBJECT', '3/1h'),
    checkDaily: rate('AGENT_CHECK_DAILY', '200/1d').limit,
    jobsIp: rate('AGENT_RATE_JOBS_IP', '600/10m'),
    modelIp: rate('AGENT_RATE_MODEL_IP', '30/10m'),
    /** `/v1/chat` and `/a2a` together. */
    chatIp: rate('AGENT_RATE_CHAT_IP', '20/10m'),
    chatDaily: rate('AGENT_CHAT_DAILY', '500/1d').limit,
    mcpIp: rate('AGENT_RATE_MCP_IP', '300/10m'),
    /** Paid endpoints without a payment (the free 402 challenge). */
    paidIp: rate('AGENT_RATE_PAID_IP', '60/10m'),
    /** Paid endpoints with a payment: the agent pays the gas to settle it, even when the transfer then fails. */
    settleIp: rate('AGENT_RATE_SETTLE_IP', '20/10m'),
  };
}

function checkerMode(value: string | undefined): 'local' | 'outlayer' {
  const mode = value || 'local';
  if (mode !== 'local' && mode !== 'outlayer') throw new Error(`CHECKER_MODE must be local or outlayer, not ${mode}`);
  return mode;
}

export type AgentConfig = ReturnType<typeof loadConfig>;

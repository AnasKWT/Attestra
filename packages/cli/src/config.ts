/**
 * CLI configuration: network, signer and service URLs from flags, then environment, then
 * defaults. Keys come from `ATTESTRA_PRIVATE_KEY` or the NEAR CLI keychain
 * (`~/.near-credentials/<network>/<account>.json`), never from flags.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AttestraClientConfig, Network } from '@attestra/sdk';

export interface CliOptions {
  network?: string;
  account?: string;
  root?: string;
  rpc?: string;
  indexer?: string;
  relayer?: string;
  agent?: string;
}

/** The hosted testnet services, so every command works with nothing running locally. */
export const HOSTED_TESTNET = { indexer: 'https://api.attestra.site/indexer', relayer: 'https://api.attestra.site/relayer', agent: 'https://api.attestra.site/agent' } as const;
/** A local stack (`pnpm dev` or Docker Compose), the default on mainnet. */
export const LOCAL = { indexer: 'http://localhost:5100', relayer: 'http://localhost:5200', agent: 'http://localhost:5300' } as const;

export function credentialsPath(network: string, accountId: string, home = homedir()): string {
  return join(home, '.near-credentials', network, `${accountId}.json`);
}

/** Reads `ed25519:...` for `accountId` from the NEAR CLI keychain, if present. */
export function keychainKey(network: string, accountId: string, home = homedir()): string | undefined {
  const p = credentialsPath(network, accountId, home);
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { private_key?: string; secret_key?: string };
    return j.private_key ?? j.secret_key;
  } catch {
    return undefined;
  }
}

export function resolveConfig(opts: CliOptions, env: NodeJS.ProcessEnv = process.env, home = homedir()): AttestraClientConfig & { network: Network } {
  const network = (opts.network ?? env.ATTESTRA_NETWORK ?? env.NEAR_NETWORK ?? 'testnet') as Network;
  if (network !== 'testnet' && network !== 'mainnet') throw new Error(`network must be testnet or mainnet, got ${network}`);
  const accountId = opts.account ?? env.ATTESTRA_ACCOUNT_ID;
  const privateKey = env.ATTESTRA_PRIVATE_KEY ?? (accountId ? keychainKey(network, accountId, home) : undefined);
  const services = network === 'testnet' ? HOSTED_TESTNET : LOCAL;
  return {
    network,
    accountId,
    privateKey,
    root: opts.root ?? env.ATTESTRA_ROOT,
    rpcUrl: opts.rpc ?? env.ATTESTRA_RPC_URL,
    indexerUrl: opts.indexer ?? env.ATTESTRA_INDEXER_URL ?? services.indexer,
    relayerUrl: opts.relayer ?? env.ATTESTRA_RELAYER_URL ?? services.relayer,
    agentUrl: opts.agent ?? env.ATTESTRA_AGENT_URL ?? services.agent,
  };
}

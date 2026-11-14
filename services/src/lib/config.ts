/** Settings every service shares, from the environment, with working public testnet defaults. */

import { resolveNetwork, type Network, type NetworkConfig } from 'attestra';
import { isPrivateKey, isValidAccountId } from 'near-kit';

export type ServiceName = 'relayer' | 'keeper' | 'topup';

export const DEFAULT_PORTS: Record<ServiceName, number> = { relayer: 5200, keeper: 5400, topup: 5500 };

export interface ServiceConfig {
  service: ServiceName;
  network: Network;
  root: string;
  rpcUrl: string;
  net: NetworkConfig;
  indexerUrl: string;
  dataDir: string;
  port: number;
  /** The account this service signs with. */
  accountId: string;
  /** Its `ed25519:` key; undefined means idle (read-only) mode. */
  privateKey?: string;
  /** Why the service is idle, when it is. */
  idleReason?: string;
}

/** Env names of the signing account: `RELAYER_*`, `KEEPER_*`, and the treasury for the top-up. */
export function accountEnv(service: ServiceName): { id: string; key: string } {
  const prefix = service === 'topup' ? 'TREASURY' : service.toUpperCase();
  return { id: `${prefix}_ACCOUNT_ID`, key: `${prefix}_PRIVATE_KEY` };
}

export function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`expected a non-negative number, got "${value}"`);
  return Math.floor(n);
}

export function loadServiceConfig(service: ServiceName, env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const network = (env.NEAR_NETWORK || 'testnet') as Network;
  if (network !== 'testnet' && network !== 'mainnet') throw new Error(`NEAR_NETWORK must be testnet or mainnet, got "${network}"`);
  const net = resolveNetwork(network, { root: env.ATTESTRA_ROOT || undefined, rpcUrl: env.RPC_URL || undefined });
  const names = accountEnv(service);
  const defaultAccount = service === 'topup' ? `attestra-treasury.${network === 'mainnet' ? 'near' : 'testnet'}` : `${service}.${net.root}`;
  const accountId = env[names.id] || defaultAccount;
  if (!isValidAccountId(accountId)) throw new Error(`${names.id} is not a valid account id: "${accountId}"`);

  const key = env[names.key]?.trim();
  let privateKey: string | undefined;
  let idleReason: string | undefined;
  if (!key) idleReason = `${names.key} is not set: idle, read-only mode`;
  else if (!isPrivateKey(key)) idleReason = `${names.key} is not a valid ed25519:/secp256k1: private key: idle, read-only mode`;
  else privateKey = key;

  return {
    service,
    network,
    root: net.root,
    rpcUrl: net.rpcUrls[0],
    net,
    indexerUrl: (env.INDEXER_URL || 'http://localhost:5100').replace(/\/+$/, ''),
    dataDir: env.DATA_DIR || '.data',
    port: int(env[`${service.toUpperCase()}_PORT`] ?? env.PORT, DEFAULT_PORTS[service]),
    accountId,
    privateKey,
    idleReason,
  };
}

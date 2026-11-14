/** Site settings from public env variables; everything has a working testnet default. */

import { NETWORKS, resolveNetwork, type Network } from 'attestra';

export const NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? 'testnet') as Network;
export const ROOT = process.env.NEXT_PUBLIC_ATTESTRA_ROOT || undefined;
export const NET = resolveNetwork(NETWORK, { root: ROOT, rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || undefined });
export const CONTRACTS = NET.contracts;
export const INDEXER_URL = (process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:5100').replace(/\/+$/, '');
export const RELAYER_URL = (process.env.NEXT_PUBLIC_RELAYER_URL ?? 'http://localhost:5200').replace(/\/+$/, '');
export const AGENT_URL = (process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://localhost:5300').replace(/\/+$/, '');
export const TOPUP_URL = (process.env.NEXT_PUBLIC_TOPUP_URL ?? 'http://localhost:5500').replace(/\/+$/, '');
export const KEEPER_URL = (process.env.NEXT_PUBLIC_KEEPER_URL ?? 'http://localhost:5400').replace(/\/+$/, '');
/** Public site URL for absolute links (llms.txt, MCP). Relative when unset. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');
export const EXPLORER = NETWORKS[NETWORK].explorerUrl;
/** The author's name, shown in the footer and about page. */
export const AUTHOR = process.env.NEXT_PUBLIC_AUTHOR_NAME || 'Anas';
export const AUTHOR_URL = process.env.NEXT_PUBLIC_AUTHOR_URL || 'https://github.com/AnasKWT';
export const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL || 'https://github.com/AnasKWT/Attestra';

export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id: string) => `${EXPLORER}/address/${id}`;

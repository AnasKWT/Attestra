/** Starts the Attestra agent. Without keys it serves its card, MCP and health, and explains what is off. */

import { serve } from '@hono/node-server';
import { AttestraClient } from '@attestra/sdk';
import { Near } from 'near-kit';
import { createApp } from './app';
import { loadConfig } from './config';
import { NearAi } from './nearai';

const config = loadConfig();
const near = config.privateKey
  ? new Near({ network: config.network, rpcUrl: config.net.rpcUrls[0], privateKey: config.privateKey as `ed25519:${string}`, defaultSignerId: config.accountId })
  : null;
const client = new AttestraClient({ network: config.network, root: config.net.root, indexerUrl: config.indexerUrl, accountId: config.accountId, near: near ?? undefined });
const app = createApp({ config, ai: new NearAi(config.nearAiKey), client, near, startedAt: Date.now() });

serve({ fetch: app.fetch, port: config.port }, () => console.log(`${new Date().toISOString()} agent listening on :${config.port} (${config.network}, ${config.accountId})`));

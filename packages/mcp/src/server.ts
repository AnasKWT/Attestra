/**
 * The Attestra MCP server. Read tools need nothing; write tools need a testnet signer
 * (ATTESTRA_ACCOUNT_ID and ATTESTRA_PRIVATE_KEY) and are capped per tool and per day.
 * On mainnet, write tools stay off unless MCP_ALLOW_MAINNET_WRITES=1.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AttestraClient, TOOLS, runTool, type AttestraClientConfig, type Network } from '@attestra/sdk';
import { DailyCaps } from './caps';

export interface McpOptions {
  network?: Network;
  root?: string;
  rpcUrl?: string;
  indexerUrl?: string;
  agentUrl?: string;
  relayerUrl?: string;
  accountId?: string;
  privateKey?: string;
  /** Force write tools off (the hosted endpoint). */
  readOnly?: boolean;
  allowMainnetWrites?: boolean;
  caps?: { perTool: number; total: number };
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): McpOptions {
  return {
    network: (env.NEAR_NETWORK ?? env.ATTESTRA_NETWORK ?? 'testnet') as Network,
    root: env.ATTESTRA_ROOT || undefined,
    rpcUrl: env.ATTESTRA_RPC_URL || undefined,
    indexerUrl: env.ATTESTRA_INDEXER_URL || 'http://localhost:5100',
    agentUrl: env.ATTESTRA_AGENT_URL || 'http://localhost:5300',
    relayerUrl: env.ATTESTRA_RELAYER_URL || 'http://localhost:5200',
    accountId: env.ATTESTRA_ACCOUNT_ID || undefined,
    privateKey: env.ATTESTRA_PRIVATE_KEY || undefined,
    readOnly: env.MCP_READ_ONLY === '1',
    allowMainnetWrites: env.MCP_ALLOW_MAINNET_WRITES === '1',
    caps: { perTool: Number(env.MCP_DAILY_CAP_PER_TOOL ?? 20), total: Number(env.MCP_DAILY_CAP_TOTAL ?? 50) },
  };
}

export function writesEnabled(o: McpOptions): boolean {
  if (o.readOnly || !o.accountId || !o.privateKey) return false;
  if ((o.network ?? 'testnet') === 'mainnet' && !o.allowMainnetWrites) return false;
  return true;
}

export function createAttestraMcpServer(o: McpOptions = optionsFromEnv(), deps: { client?: AttestraClient; caps?: DailyCaps } = {}) {
  const cfg: AttestraClientConfig = {
    network: o.network ?? 'testnet',
    root: o.root,
    rpcUrl: o.rpcUrl,
    indexerUrl: o.indexerUrl,
    agentUrl: o.agentUrl,
    relayerUrl: o.relayerUrl,
    accountId: o.accountId,
    privateKey: o.privateKey,
  };
  const client = deps.client ?? new AttestraClient(cfg);
  const writes = writesEnabled(o);
  const caps = deps.caps ?? new DailyCaps(o.caps ?? { perTool: 20, total: 50 });
  const tools = TOOLS.filter((t) => writes || !t.write);

  const server = new Server(
    { name: 'attestra', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Attestra is the attestation protocol on NEAR. Use get_attestation or verify_attestation to check a claim, get_agent_reputation before trusting an agent, and prove_attestation to prove an event is final with a light client proof. Write tools run on testnet only and are capped per day.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.write ? `${t.description} (writes on NEAR ${o.network ?? 'testnet'}; capped per day)` : t.description,
      inputSchema: t.parameters,
      annotations: { readOnlyHint: !t.write, openWorldHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: TOOLS.some((t) => t.name === name) ? `${name} writes on chain and is disabled here (set a testnet signer to enable it)` : `unknown tool ${name}` }] };
    }
    if (tool.write) {
      const cap = caps.take(name);
      if (!cap.ok) return { isError: true, content: [{ type: 'text', text: cap.reason }] };
    }
    const result = (await runTool(client, name, (req.params.arguments ?? {}) as Record<string, unknown>, { allowWrites: writes })) as { ok?: boolean };
    return { isError: result?.ok === false, content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  return { server, client, caps, writes, toolNames: tools.map((t) => t.name) };
}

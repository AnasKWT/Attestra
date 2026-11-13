/**
 * The Attestra MCP server. Read tools need nothing; write tools need a testnet signer
 * (ATTESTRA_ACCOUNT_ID and ATTESTRA_PRIVATE_KEY), are capped per tool and per day, and each call
 * stays within spend limits (key allowance, deposit, x402 payment).
 * On mainnet, write tools stay off unless MCP_ALLOW_MAINNET_WRITES=1.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AttestraClient, TOOLS, WRITE_TOOLS, runTool, type AttestraClientConfig, type Network, type ToolLimits } from '@attestra/sdk';
import { DEFAULT_TOOL_CAPS, DailyCaps, type CapConfig } from './caps';

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
  caps?: CapConfig;
  /** Per-call spend limits; what is not set comes from the SDK's `defaultToolLimits`. */
  limits?: Partial<ToolLimits>;
}

/** `MCP_DAILY_CAP_<TOOL>` (for example MCP_DAILY_CAP_GRANT_AGENT_KEY) over the default tighter caps. */
function toolCapsFromEnv(env: NodeJS.ProcessEnv): Record<string, number> {
  const caps = { ...DEFAULT_TOOL_CAPS };
  for (const name of WRITE_TOOLS) {
    const v = env[`MCP_DAILY_CAP_${name.toUpperCase()}`];
    if (v !== undefined && v !== '' && Number.isFinite(Number(v))) caps[name] = Number(v);
  }
  return caps;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): McpOptions {
  const network = (env.NEAR_NETWORK ?? env.ATTESTRA_NETWORK ?? 'testnet') as Network;
  // The hosted testnet services answer with nothing running locally; mainnet uses a local stack.
  const base = network === 'testnet' ? 'https://api.attestra.site' : null;
  return {
    network,
    root: env.ATTESTRA_ROOT || undefined,
    rpcUrl: env.ATTESTRA_RPC_URL || undefined,
    indexerUrl: env.ATTESTRA_INDEXER_URL || (base ? `${base}/indexer` : 'http://localhost:5100'),
    agentUrl: env.ATTESTRA_AGENT_URL || (base ? `${base}/agent` : 'http://localhost:5300'),
    relayerUrl: env.ATTESTRA_RELAYER_URL || (base ? `${base}/relayer` : 'http://localhost:5200'),
    accountId: env.ATTESTRA_ACCOUNT_ID || undefined,
    privateKey: env.ATTESTRA_PRIVATE_KEY || undefined,
    readOnly: env.MCP_READ_ONLY === '1',
    allowMainnetWrites: env.MCP_ALLOW_MAINNET_WRITES === '1',
    caps: { perTool: Number(env.MCP_DAILY_CAP_PER_TOOL ?? 20), total: Number(env.MCP_DAILY_CAP_TOTAL ?? 50), tools: toolCapsFromEnv(env) },
    limits: {
      maxKeyAllowanceNear: env.MCP_MAX_KEY_ALLOWANCE_NEAR || undefined,
      maxDepositNear: env.MCP_MAX_DEPOSIT_NEAR || undefined,
      maxPayment: env.MCP_MAX_PAYMENT || undefined,
    },
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
  const caps = deps.caps ?? new DailyCaps(o.caps ?? { perTool: 20, total: 50, tools: DEFAULT_TOOL_CAPS });
  const tools = TOOLS.filter((t) => writes || !t.write);

  const server = new Server(
    { name: 'attestra', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Attestra is the attestation protocol on NEAR. Use get_attestation or verify_attestation to check a claim, get_agent_reputation and list_agent_keys before trusting an agent, linked_account to find the NEAR account behind a wallet on another chain, and prove_attestation to prove an event is final with a light client proof. Write tools run on testnet only, are capped per day and stay within spend limits per call.',
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
    const result = (await runTool(client, name, (req.params.arguments ?? {}) as Record<string, unknown>, { allowWrites: writes, limits: o.limits })) as { ok?: boolean };
    return { isError: result?.ok === false, content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  return { server, client, caps, writes, toolNames: tools.map((t) => t.name) };
}

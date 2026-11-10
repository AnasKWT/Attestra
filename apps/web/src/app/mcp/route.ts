/** Hosted MCP endpoint (Streamable HTTP, stateless). Read tools only: write tools need your own key via `npx @attestra/mcp`. */

import { handleMcpRequest } from '@attestra/mcp';
import { AGENT_URL, INDEXER_URL, NETWORK, RELAYER_URL, ROOT } from '@/lib/config';

export const dynamic = 'force-dynamic';

const options = { network: NETWORK, root: ROOT, indexerUrl: process.env.INDEXER_URL ?? INDEXER_URL, agentUrl: AGENT_URL, relayerUrl: RELAYER_URL, readOnly: true };

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, accept, mcp-session-id, mcp-protocol-version', 'access-control-allow-methods': 'POST, OPTIONS' };

async function handle(req: Request) {
  const res = await handleMcpRequest(req, options);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

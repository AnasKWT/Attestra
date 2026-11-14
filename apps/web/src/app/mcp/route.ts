/** Hosted MCP endpoint (Streamable HTTP, stateless). Read tools only: write tools need your own key via `npx attestra-mcp`. */

import { handleMcpRequest } from 'attestra-mcp';
import { clientAddress, parseRate, RATE_LIMIT_HEADERS, rateLimitHeaders, takeAll, TokenBucket, tooManyRequests, trustProxySetting } from 'attestra';
import { AGENT_URL, INDEXER_URL, NETWORK, RELAYER_URL, ROOT } from '@/lib/config';

export const dynamic = 'force-dynamic';

const options = { network: NETWORK, root: ROOT, indexerUrl: process.env.INDEXER_URL ?? INDEXER_URL, agentUrl: AGENT_URL, relayerUrl: RELAYER_URL, readOnly: true };

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, accept, mcp-session-id, mcp-protocol-version',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-expose-headers': RATE_LIMIT_HEADERS.join(', '),
};

// Per client address (MCP_RATE_IP). On Vercel every serverless instance keeps its own buckets in
// memory, so the limit holds per instance rather than across the deployment: enough to stop one
// client from driving the indexer and the RPC through this route, without a shared store.
// Vercel sets X-Forwarded-For to the client's address itself; elsewhere it is read only with TRUST_PROXY.
const perAddress = new TokenBucket(parseRate(process.env.MCP_RATE_IP, '300/10m'));
const trustProxy = process.env.VERCEL ? true : trustProxySetting(process.env.TRUST_PROXY);

async function handle(req: Request) {
  const address = clientAddress({ forwardedFor: req.headers.get('x-forwarded-for'), remote: null, trustProxy });
  const limit = takeAll([{ limiter: perAddress, key: address, scope: 'from one address' }]);
  const res = limit.ok ? await handleMcpRequest(req, options) : tooManyRequests(limit, 'MCP requests');
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...cors, ...rateLimitHeaders(limit) })) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

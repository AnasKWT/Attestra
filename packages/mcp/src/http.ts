/** Stateless Streamable HTTP handler: one server per request, for serverless hosts and the site's /mcp route. */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createAttestraMcpServer, type McpOptions } from './server';

/** A stateless server has no session to stream to (GET) or to end (DELETE): only POST carries requests. */
const POST_ONLY = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: send JSON-RPC requests with POST' }, id: null };

export async function handleMcpRequest(request: Request, options: McpOptions): Promise<Response> {
  if (request.method !== 'POST') return Response.json(POST_ONLY, { status: 405, headers: { allow: 'POST' } });
  const { server } = createAttestraMcpServer(options);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}

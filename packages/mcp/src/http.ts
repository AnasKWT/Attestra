/** Stateless Streamable HTTP handler: one server per request, for serverless hosts and the site's /mcp route. */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createAttestraMcpServer, type McpOptions } from './server';

export async function handleMcpRequest(request: Request, options: McpOptions): Promise<Response> {
  const { server } = createAttestraMcpServer(options);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}

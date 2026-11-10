/**
 * attestra-mcp: the Attestra MCP server.
 *
 *   npx -y @attestra/mcp                 stdio (Claude Code, Codex, Claude Desktop)
 *   npx -y @attestra/mcp --http 5600     Streamable HTTP on /mcp
 */

import { createServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_TOOL_CAPS, DailyCaps } from './caps';
import { handleMcpRequest } from './http';
import { createAttestraMcpServer, optionsFromEnv } from './server';

const args = process.argv.slice(2);
const httpAt = args.indexOf('--http');
const options = optionsFromEnv();

if (httpAt >= 0) {
  const port = Number(args[httpAt + 1] ?? process.env.PORT ?? 5600);
  // Every request gets its own server, so the daily caps live here.
  const caps = new DailyCaps(options.caps ?? { perTool: 20, total: 50, tools: DEFAULT_TOOL_CAPS });
  createServer(async (req, res) => {
    if (req.url === '/live' || req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, service: 'mcp' }));
      return;
    }
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    const response = await handleMcpRequest(request, options, { caps });
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  }).listen(port, () => console.error(`attestra-mcp listening on http://localhost:${port}/mcp`));
} else {
  const { server, writes, toolNames } = createAttestraMcpServer(options);
  await server.connect(new StdioServerTransport());
  console.error(`attestra-mcp ready on stdio (${options.network}, ${toolNames.length} tools, writes ${writes ? 'on' : 'off'})`);
}

/** Machine-facing routes: /llms.txt for language models and the hosted MCP endpoint. */

import { computeSchemaUid } from '@attestra/sdk';
import { expect, test } from './support';

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

test('/llms.txt describes the protocol, the MCP and the SDK', async ({ request }) => {
  const res = await request.get('/llms.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/plain');
  const text = await res.text();
  expect(text).toMatch(/^# Attestra\n/);
  expect(text).toContain('## Agent access');
  expect(text).toMatch(/MCP \(Streamable HTTP, read tools\): \S*\/mcp/);
  expect(text).toContain('npx -y @attestra/mcp');
  expect(text).toContain('## SDK (TypeScript, @attestra/sdk)');
  expect(text).toContain('new AttestraClient(');
  expect(text).toContain('schemas.attestra.testnet');
});

test('/mcp answers initialize over JSON-RPC', async ({ request }) => {
  const res = await request.post('/mcp', {
    headers: MCP_HEADERS,
    data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } } },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['access-control-allow-origin']).toBe('*');
  const body = await res.json();
  expect(body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'attestra' }, capabilities: { tools: {} } } });
});

test('/mcp lists only read tools', async ({ request }) => {
  const res = await request.post('/mcp', { headers: MCP_HEADERS, data: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  expect(res.status()).toBe(200);
  const tools = ((await res.json()).result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>);
  const names = tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(['get_schema', 'get_attestation', 'verify_attestation', 'compute_schema_uid', 'decode_data']));
  expect(names).not.toContain('create_attestation');
  expect(names).not.toContain('register_schema');
  for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
});

test('/mcp runs an offline tool and matches the SDK', async ({ request }) => {
  const definition = 'string name, u8 level, bool verified';
  const res = await request.post('/mcp', {
    headers: MCP_HEADERS,
    data: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'compute_schema_uid', arguments: { definition, revocable: true } } },
  });
  expect(res.status()).toBe(200);
  const text = (await res.json()).result.content[0].text as string;
  expect(text).toContain(computeSchemaUid(definition, null, true));
});

test('/mcp answers GET with 405 and a JSON-RPC error, since the endpoint is stateless', async ({ request }) => {
  for (const accept of ['text/html', 'text/event-stream']) {
    const res = await request.get('/mcp', { headers: { accept } });
    expect(res.status(), accept).toBe(405);
    expect(res.headers().allow).toContain('POST');
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
  }
});

test('/mcp answers a CORS preflight', async ({ request }) => {
  const res = await request.fetch('/mcp', { method: 'OPTIONS' });
  expect(res.status()).toBe(204);
  expect(res.headers()['access-control-allow-methods']).toContain('POST');
});

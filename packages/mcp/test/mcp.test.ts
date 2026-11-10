import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { AttestraClient, READ_TOOLS, TOOLS, WRITE_TOOLS } from '@attestra/sdk';
import { DailyCaps } from '../src/caps';
import { handleMcpRequest } from '../src/http';
import { createAttestraMcpServer, writesEnabled } from '../src/server';

/** A client whose chain calls are fakes, so every tool can be driven offline. */
class FakeClient extends AttestraClient {
  calls: string[] = [];
  override async view<T>(_c: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(method);
    if (method === 'get_schema') return { uid: args.uid, definition: 'string name, u8 level', authority: 'a.testnet', resolver: null, revocable: true, created_at: 1, status: 'active', blob_hash: null } as T;
    if (method === 'get_attestation') return { uid: args.uid, schema_uid: 'aa'.repeat(32), attester: 'a.testnet', subject: 'b.testnet', data: 'AgAAAEJvBw==', created_at: 1, expiration_time: 0, revoked: false, revocation_time: 0, revoke_at: 0, nonce: 0, ref_uid: null, status: 'active' } as T;
    if (method === 'get_authority') return { account_id: args.account_id, metadata: 'Acme', kind: 'organization', verified: true } as T;
    if (method === 'get_delegates') return [] as T;
    if (method === 'list_schemas') return [] as T;
    if (method === 'schema_count') return 0 as T;
    return null as T;
  }
  override async callRaw<T>(_c: string, method: string): Promise<{ value: T; txHash: string }> {
    this.calls.push(`call:${method}`);
    if (method === 'register_schema') return { value: 'cc'.repeat(32) as T, txHash: 'TX' };
    return { value: { uid: 'dd'.repeat(32), status: method === 'revoke' ? 'revoked' : 'created' } as T, txHash: 'TX' };
  }
}

async function connect(opts: Parameters<typeof createAttestraMcpServer>[0], client = new FakeClient({ network: 'testnet', accountId: 'me.testnet' }), caps?: DailyCaps) {
  const { server } = createAttestraMcpServer(opts, { client, caps });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), c.connect(b)]);
  return { c, client };
}

const text = (r: object) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

describe('Attestra MCP server', () => {
  it('lists only read tools without a signer', async () => {
    const { c } = await connect({ network: 'testnet' });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    const r = await c.callTool({ name: 'register_schema', arguments: { definition: 'string a', revocable: true } });
    expect(r.isError).toBe(true);
  });

  it('drives every read tool', async () => {
    const { c } = await connect({ network: 'testnet' });
    const uid = 'ab'.repeat(32);
    const args: Record<string, Record<string, unknown>> = {
      get_schema: { uid },
      list_schemas: {},
      well_known_schemas: {},
      get_attestation: { uid },
      verify_attestation: { uid },
      list_attestations: {},
      get_authority: { account_id: 'acme.testnet' },
      get_delegates: { authority: 'acme.testnet' },
      get_agent_reputation: { agent: 'agent.testnet' },
      prove_attestation: { uid },
      decode_data: { definition: 'string name, u8 level', data: 'AgAAAEJvBw==' },
      compute_schema_uid: { definition: 'string name, u8 level', revocable: true },
    };
    for (const name of READ_TOOLS) {
      const r = await c.callTool({ name, arguments: args[name] });
      expect(r.content).toBeDefined();
    }
    expect(text(await c.callTool({ name: 'verify_attestation', arguments: { uid } })).data.valid).toBe(true);
    expect(text(await c.callTool({ name: 'get_attestation', arguments: { uid } })).data.decoded).toEqual({ name: 'Bo', level: 7 });
    expect(text(await c.callTool({ name: 'compute_schema_uid', arguments: args.compute_schema_uid })).data.uid).toBe('b7707f26a2b3f1bd97ad1c8919f9c78e47031eb71092bdc441ed441110b8f452');
  });

  it('drives write tools with a testnet signer and caps them', async () => {
    const caps = new DailyCaps({ perTool: 1, total: 3 });
    const { c, client } = await connect({ network: 'testnet', accountId: 'me.testnet', privateKey: 'ed25519:x' }, undefined, caps);
    const { tools } = await c.listTools();
    expect(tools.length).toBe(TOOLS.length);
    for (const w of WRITE_TOOLS) expect(tools.some((t) => t.name === w)).toBe(true);
    const reg = text(await c.callTool({ name: 'register_schema', arguments: { definition: 'string a', revocable: true } }));
    expect(reg.data.schemaUid).toBe('cc'.repeat(32));
    const att = text(await c.callTool({ name: 'create_attestation', arguments: { schema_uid: 'aa'.repeat(32), subject: 'b.testnet', values: { name: 'Bo', level: 7 } } }));
    expect(att.data.attestationUid).toBe('dd'.repeat(32));
    expect(text(await c.callTool({ name: 'revoke_attestation', arguments: { uid: 'dd'.repeat(32) } })).data.status).toBe('revoked');
    const again = await c.callTool({ name: 'register_schema', arguments: { definition: 'string b', revocable: true } });
    expect(again.isError).toBe(true);
    expect((client as FakeClient).calls).toContain('call:attest');
    const rate = await c.callTool({ name: 'rate_agent', arguments: { agent: 'x.testnet', score: 5 } });
    expect(rate.isError).toBe(true);
  });

  it('keeps writes off on mainnet and in read-only mode', () => {
    expect(writesEnabled({ network: 'mainnet', accountId: 'a', privateKey: 'k' })).toBe(false);
    expect(writesEnabled({ network: 'mainnet', accountId: 'a', privateKey: 'k', allowMainnetWrites: true })).toBe(true);
    expect(writesEnabled({ network: 'testnet', accountId: 'a', privateKey: 'k', readOnly: true })).toBe(false);
  });

  it('answers over stateless Streamable HTTP', async () => {
    const init = await handleMcpRequest(
      new Request('http://x/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      }),
      { network: 'testnet', readOnly: true },
    );
    expect(init.status).toBe(200);
    const body = (await init.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('attestra');
  });

  it('answers GET and DELETE with 405 instead of opening a stream no server will write to', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await handleMcpRequest(new Request('http://x/mcp', { method, headers: { accept: 'text/event-stream' } }), { network: 'testnet', readOnly: true });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
    }
  });
});

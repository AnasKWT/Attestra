import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { AttestraClient, READ_TOOLS, TOOLS, WRITE_TOOLS } from '@attestra/sdk';
import { DEFAULT_TOOL_CAPS, DailyCaps } from '../src/caps';
import { handleMcpRequest } from '../src/http';
import { createAttestraMcpServer, optionsFromEnv, writesEnabled } from '../src/server';

const KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';

/** A near-kit stand-in for key transactions: records each action and answers success. */
function fakeNear(actions: string[]) {
  const builder = {
    addKey: (pk: string, p: { methodNames: string[]; allowance: bigint }) => (actions.push(`addKey:${pk}:${p.methodNames.join(',')}:${p.allowance}`), builder),
    deleteKey: (_a: string, pk: string) => (actions.push(`deleteKey:${pk}`), builder),
    send: async () => ({ status: { SuccessValue: '' }, transaction: { hash: 'KEYTX' } }),
  };
  return { transaction: () => builder } as unknown as AttestraClient['near'];
}

/** A client whose chain calls are fakes, so every tool can be driven offline. */
class FakeClient extends AttestraClient {
  calls: string[] = [];
  /** What the verdicts contract asks as a deposit, in yoctoNEAR. */
  deposit = '1000';
  override async rpc<T>(_m: string, params: unknown): Promise<T> {
    const p = params as { request_type: string; account_id: string };
    this.calls.push(`rpc:${p.request_type}`);
    const fc = { FunctionCall: { allowance: '1', receiver_id: this.contracts.attestations, method_names: ['attest'] } };
    if (p.request_type === 'view_access_key_list') return { keys: [{ public_key: KEY, access_key: { nonce: 1, permission: fc } }, { public_key: 'ed25519:x', access_key: { nonce: 1, permission: 'FullAccess' } }] } as T;
    return null as T;
  }
  override async paidVerify(kind: 'claim' | 'agent', target: string, maxAmount?: bigint) {
    this.calls.push(`paid:${kind}:${target}:${maxAmount}`);
    return { success: true as const, data: { result: { valid: true }, settlement: null } };
  }
  override async view<T>(_c: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(method);
    if (method === 'link_message') return `link ${args.chain}:${args.address} to ${args.account_id}` as T;
    if (method === 'linked_account') return 'alice.testnet' as T;
    if (method === 'link_wallet_deposit' || method === 'foreign_event_deposit') return this.deposit as T;
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
      linked_account: { caip10: 'eip155:1:0xabc' },
      wallet_link_message: { account_id: 'alice.testnet', chain: 'eip155', address: '0xabc' },
      list_agent_keys: { account_id: 'alice.testnet' },
      list_dao_proposals: { dao: 'guild.sputnik-v2.testnet', limit: 2 },
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
    expect(text(await c.callTool({ name: 'linked_account', arguments: args.linked_account })).data).toEqual({ accountId: 'alice.testnet' });
    expect(text(await c.callTool({ name: 'wallet_link_message', arguments: args.wallet_link_message })).data.message).toBe('link eip155:0xabc to alice.testnet');
    expect(text(await c.callTool({ name: 'list_agent_keys', arguments: args.list_agent_keys })).data.keys).toEqual([
      { publicKey: KEY, receiverId: 'attestations.attestra.testnet', methodNames: ['attest'], allowance: '1' },
    ]);
  });

  it('drives the NEAR-only write tools within spend limits and tighter caps', async () => {
    const actions: string[] = [];
    const client = new FakeClient({ network: 'testnet', accountId: 'me.testnet', near: fakeNear(actions) });
    const caps = new DailyCaps({ perTool: 20, total: 50, tools: { ...DEFAULT_TOOL_CAPS, grant_agent_key: 1 } });
    const { c } = await connect({ network: 'testnet', accountId: 'me.testnet', privateKey: 'ed25519:x', limits: { maxPayment: '100' } }, client, caps);
    const call = (name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: args });
    const log = { removed: false, log_index: 0, transaction_index: 0, transaction_hash: '0x' + '11'.repeat(32), block_hash: '0x' + '22'.repeat(32), block_number: 1, address: '0x' + '33'.repeat(20), data: '0x', topics: [] };

    expect(text(await call('attest_foreign_event', { chain: 'base', tx_id: '0x' + '11'.repeat(32), log_index: 0, log })).data.status).toBe('created');
    expect(text(await call('link_wallet', { chain: 'eip155', address: '0xabc', signature: '0xsig' })).data.status).toBe('created');
    expect(text(await call('register_agent', { agent: 'bot.testnet', name: 'Bot', model: 'm', capabilities: ['verify'] })).data.attestationUid).toBe('dd'.repeat(32));
    expect(text(await call('delegate_to_agent', { agent: 'bot.testnet', expires_at: 2_000_000_000 })).ok).toBe(true);
    const granted = text(await call('grant_agent_key', { public_key: KEY, methods: ['attest', 'revoke'], allowance_near: '0.5' }));
    expect(granted).toMatchObject({ ok: true, tx_hash: 'KEYTX', data: { methodNames: ['attest', 'revoke'], allowance: '500000000000000000000000' } });
    expect(text(await call('paid_verify', { kind: 'agent', target: 'bot.testnet' })).data.result.valid).toBe(true);
    expect(client.calls).toEqual(expect.arrayContaining(['call:attest_foreign_event', 'call:link_wallet', 'call:attest', 'call:add_delegate', 'paid:agent:bot.testnet:100']));
    expect(actions).toEqual([`addKey:${KEY}:attest,revoke:500000000000000000000000`]);

    // The grant cap of 1 is used up; the other limits refuse before anything is sent.
    const second = await call('grant_agent_key', { public_key: KEY });
    expect(second.isError).toBe(true);
    expect((second.content as Array<{ text: string }>)[0].text).toMatch(/grant_agent_key reached its daily cap of 1/);
    client.deposit = (3n * 10n ** 23n).toString();
    const deposit = await call('link_wallet', { chain: 'eip155', address: '0xdef', signature: '0xsig' });
    expect(deposit.isError).toBe(true);
    expect(text(deposit).error).toMatchObject({ type: 'VALIDATION_ERROR', message: expect.stringMatching(/above the limit/) });
    expect(text(await call('paid_verify', { kind: 'claim', target: 'ab'.repeat(32), max_amount: '101' })).error.type).toBe('VALIDATION_ERROR');
    expect(text(await call('delegate_to_agent', { agent: 'bot.testnet' })).error.message).toMatch(/expires_at or max_uses/);
    expect(client.calls.filter((x) => x === 'call:link_wallet').length).toBe(1);
  });

  it('reads caps and spend limits from the environment', () => {
    const o = optionsFromEnv({ MCP_DAILY_CAP_GRANT_AGENT_KEY: '2', MCP_DAILY_CAP_PAID_VERIFY: '7', MCP_MAX_KEY_ALLOWANCE_NEAR: '0.5', MCP_MAX_PAYMENT: '10' });
    expect(o.caps?.tools).toEqual({ ...DEFAULT_TOOL_CAPS, grant_agent_key: 2, paid_verify: 7 });
    expect(o.limits).toEqual({ maxKeyAllowanceNear: '0.5', maxDepositNear: undefined, maxPayment: '10' });
    const caps = new DailyCaps(o.caps!);
    expect(caps.capOf('grant_agent_key')).toBe(2);
    expect(caps.capOf('delegate_to_agent')).toBe(DEFAULT_TOOL_CAPS.delegate_to_agent);
    expect(caps.capOf('create_attestation')).toBe(20);
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

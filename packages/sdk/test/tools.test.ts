import { describe, expect, it } from 'vitest';
import { AttestraClient } from '../src/client';
import { READ_TOOLS, TOOLS, WRITE_TOOLS, defaultToolLimits, openAITools, runTool } from '../src/tools';
import { knownSchemas } from '../src/schemas';
import type { DelegateScope, ServiceResponse } from '../src/types';

/** Records each SDK call a tool makes and answers it, so tools run offline. */
class MockClient extends AttestraClient {
  calls: Array<[string, ...unknown[]]> = [];
  private done<T>(name: string, args: unknown[], data: T): Promise<ServiceResponse<T>> {
    this.calls.push([name, ...args]);
    return Promise.resolve({ success: true, data, txHash: 'TX' });
  }
  override linkedAccount(caip10: string) {
    this.calls.push(['linkedAccount', caip10]);
    return Promise.resolve({ success: true as const, data: { accountId: 'alice.testnet' } });
  }
  override linkWalletMessage(accountId: string, chain: 'eip155' | 'solana', address: string) {
    this.calls.push(['linkWalletMessage', accountId, chain, address]);
    return Promise.resolve({ success: true as const, data: { message: 'link me' } });
  }
  override agentKeys(accountId: string) {
    this.calls.push(['agentKeys', accountId]);
    return Promise.resolve({ success: true as const, data: { keys: [] } });
  }
  override attestForeignEvent(...a: Parameters<AttestraClient['attestForeignEvent']>) {
    return this.done('attestForeignEvent', a, { uid: 'ee'.repeat(32), status: 'created' });
  }
  override linkWallet(...a: Parameters<AttestraClient['linkWallet']>) {
    return this.done('linkWallet', a, { uid: 'ff'.repeat(32), status: 'created' });
  }
  override registerAgent(...a: Parameters<AttestraClient['registerAgent']>) {
    return this.done('registerAgent', a, { attestationUid: 'aa'.repeat(32), status: 'created' });
  }
  override delegateToAgent(agent: string, scope: DelegateScope) {
    return this.done<void>('delegateToAgent', [agent, scope], undefined);
  }
  override grantAgentKey(...a: Parameters<AttestraClient['grantAgentKey']>) {
    return this.done('grantAgentKey', a, { publicKey: a[0], receiverId: this.contracts.attestations, methodNames: ['attest'], allowance: '1' });
  }
  override paidVerify(...a: Parameters<AttestraClient['paidVerify']>) {
    return this.done('paidVerify', a, { result: { valid: true }, settlement: null });
  }
}

const KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';

describe('agent tools', () => {
  const client = new AttestraClient({ network: 'testnet' });

  it('exposes read and write tools with JSON schemas', () => {
    expect(READ_TOOLS).toContain('get_attestation');
    expect(READ_TOOLS).toContain('prove_attestation');
    expect(WRITE_TOOLS).toEqual(expect.arrayContaining(['register_schema', 'create_attestation', 'revoke_attestation', 'request_private_check']));
    for (const t of TOOLS) expect(t.parameters.type).toBe('object');
    expect(openAITools().length).toBe(READ_TOOLS.length);
    expect(openAITools({ includeWrites: true }).length).toBe(TOOLS.length);
  });

  it('blocks writes unless allowed, and runs pure tools offline', async () => {
    const blocked = (await runTool(client, 'register_schema', { definition: 'string a', revocable: true })) as { ok: boolean };
    expect(blocked.ok).toBe(false);
    const uid = (await runTool(client, 'compute_schema_uid', { definition: 'string name, u8 level', revocable: true })) as { data: { uid: string } };
    expect(uid.data.uid).toBe('b7707f26a2b3f1bd97ad1c8919f9c78e47031eb71092bdc441ed441110b8f452');
    const dec = (await runTool(client, 'decode_data', { definition: 'string name, u8 level', data: 'AgAAAEJvBw==' })) as { data: unknown };
    expect(dec.data).toEqual({ name: 'Bo', level: 7 });
    const unknown = (await runTool(client, 'nope', {})) as { ok: boolean };
    expect(unknown.ok).toBe(false);
  });

  it('well-known schemas have stable UIDs', () => {
    const all = knownSchemas();
    expect(new Set(all.map((s) => s.uid)).size).toBe(all.length);
    for (const s of all) expect(s.uid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('client config switches networks', () => {
    expect(client.contracts.attestations).toBe('attestations.attestra.testnet');
    const main = new AttestraClient({ network: 'mainnet' });
    expect(main.contracts.attestations).toBe('attestations.attestra.near');
    expect(main.config.mpc).toBe('v1.signer');
    const custom = new AttestraClient({ network: 'testnet', root: 'demo.testnet' });
    expect(custom.contracts.resolvers.fee).toBe('fee.demo.testnet');
  });

  it('writes without a signer fail as configuration errors', async () => {
    const r = await client.registerSchema({ definition: 'string a', revocable: true });
    expect(r.success).toBe(false);
    expect(r.error?.type).toBe('CONFIGURATION_ERROR');
  });

  it('runs the NEAR-only read tools', async () => {
    const c = new MockClient({ network: 'testnet' });
    expect(READ_TOOLS).toEqual(expect.arrayContaining(['linked_account', 'wallet_link_message', 'list_agent_keys']));
    expect(await runTool(c, 'linked_account', { caip10: 'eip155:1:0xabc' })).toEqual({ ok: true, data: { accountId: 'alice.testnet' } });
    expect(await runTool(c, 'wallet_link_message', { account_id: 'alice.testnet', chain: 'eip155', address: '0xabc' })).toEqual({ ok: true, data: { message: 'link me' } });
    expect(await runTool(c, 'list_agent_keys', { account_id: 'alice.testnet' })).toEqual({ ok: true, data: { keys: [] } });
    expect(c.calls).toEqual([['linkedAccount', 'eip155:1:0xabc'], ['linkWalletMessage', 'alice.testnet', 'eip155', '0xabc'], ['agentKeys', 'alice.testnet']]);
  });

  it('runs the NEAR-only write tools with the default spend limits', async () => {
    const c = new MockClient({ network: 'testnet', accountId: 'me.testnet' });
    const w = { allowWrites: true };
    expect(WRITE_TOOLS).toEqual(expect.arrayContaining(['attest_foreign_event', 'link_wallet', 'register_agent', 'delegate_to_agent', 'grant_agent_key', 'paid_verify']));
    expect(await runTool(c, 'attest_foreign_event', { chain: 'base', tx_id: '0x' + '11'.repeat(32), log_index: 2 }, w)).toMatchObject({ ok: true, tx_hash: 'TX' });
    expect(await runTool(c, 'link_wallet', { chain: 'solana', address: 'So1', signature: 'sig' }, w)).toMatchObject({ ok: true });
    expect(await runTool(c, 'register_agent', { agent: 'bot.testnet', name: 'Bot', model: 'm', capabilities: ['verify'] }, w)).toMatchObject({ ok: true });
    expect(await runTool(c, 'delegate_to_agent', { agent: 'bot.testnet', max_uses: 3, schemas: ['ab'.repeat(32)] }, w)).toMatchObject({ ok: true });
    expect(await runTool(c, 'grant_agent_key', { public_key: KEY }, w)).toMatchObject({ ok: true, data: { publicKey: KEY } });
    expect(await runTool(c, 'paid_verify', { kind: 'claim', target: 'ab'.repeat(32) }, w)).toMatchObject({ ok: true, data: { result: { valid: true } } });
    const quarter = 25n * 10n ** 22n;
    expect(c.calls).toEqual([
      ['attestForeignEvent', { chain: 'base', txId: '0x' + '11'.repeat(32), logIndex: 2, log: undefined, subject: undefined }, { maxDeposit: quarter }],
      ['linkWallet', 'solana', 'So1', 'sig', { maxDeposit: quarter }],
      ['registerAgent', { agent: 'bot.testnet', name: 'Bot', model: 'm', capabilities: ['verify'], endpoint: '', description: undefined }],
      ['delegateToAgent', 'bot.testnet', { schemas: ['ab'.repeat(32)], expiresAt: undefined, maxUses: 3, canRevoke: undefined }],
      ['grantAgentKey', KEY, { methods: undefined, allowanceNear: '0.25' }],
      ['paidVerify', 'claim', 'ab'.repeat(32), BigInt(defaultToolLimits('testnet').maxPayment)],
    ]);
  });

  it('refuses unbounded delegations and anything above the spend limits', async () => {
    const c = new MockClient({ network: 'testnet', accountId: 'me.testnet' });
    const w = { allowWrites: true, limits: { maxKeyAllowanceNear: '0.5', maxPayment: '100' } };
    const refused = async (name: string, args: Record<string, unknown>) => {
      const r = (await runTool(c, name, args, w)) as { ok: boolean; error: { type: string; message: string } };
      expect(r.ok).toBe(false);
      expect(r.error.type).toBe('VALIDATION_ERROR');
      return r.error.message;
    };
    expect(await refused('delegate_to_agent', { agent: 'bot.testnet' })).toMatch(/expires_at or max_uses/);
    expect(await refused('grant_agent_key', { public_key: KEY, allowance_near: '0.6' })).toMatch(/above the limit of 0.5 NEAR/);
    expect(await refused('grant_agent_key', { public_key: KEY, allowance_near: 'lots' })).toMatch(/amount of NEAR/);
    expect(await refused('paid_verify', { kind: 'agent', target: 'bot.testnet', max_amount: '101' })).toMatch(/above the limit of 100/);
    expect(await refused('paid_verify', { kind: 'agent', target: 'bot.testnet', max_amount: '1.5' })).toMatch(/whole number/);
    expect(await refused('paid_verify', { kind: 'other', target: 'x' })).toMatch(/claim or agent/);
    expect(c.calls).toEqual([]);
    await runTool(c, 'paid_verify', { kind: 'agent', target: 'bot.testnet', max_amount: '40' }, w);
    await runTool(c, 'grant_agent_key', { public_key: KEY, allowance_near: '0.5', methods: ['attest'] }, w);
    expect(c.calls).toEqual([
      ['paidVerify', 'agent', 'bot.testnet', 40n],
      ['grantAgentKey', KEY, { methods: ['attest'], allowanceNear: '0.5' }],
    ]);
  });

  it('defaults the payment limit to the network token', () => {
    expect(defaultToolLimits('testnet').maxPayment).toBe('5000000000000000000');
    expect(defaultToolLimits('mainnet').maxPayment).toBe('50000');
  });
});


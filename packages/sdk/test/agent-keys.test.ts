import type { Near } from 'near-kit';
import { describe, expect, it } from 'vitest';
import { AGENT_KEY_GRANTABLE_METHODS, AGENT_KEY_METHODS, agentKeyGrant, agentKeysFrom, nearToYocto } from '../src/agent-keys';
import { AttestraClient } from '../src/client';

const KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
const OTHER = 'ed25519:H9k5eiU4xEa6nKHGsEVF8gJJDnrCuxuMGbMCnrTKxDKn';
const ATT = 'attestations.attestra.testnet';

/** A near-kit stand-in that records the transaction the client builds. */
function fakeNear(outcome: unknown = { status: { SuccessValue: '' }, transaction: { hash: 'TXH' } }) {
  const sent: Array<{ signer: string; actions: unknown[]; waitUntil?: string }> = [];
  const near = {
    transaction(signer: string) {
      const tx = { signer, actions: [] as unknown[], waitUntil: undefined as string | undefined };
      const b = {
        addKey: (pk: string, permission: unknown) => (tx.actions.push({ addKey: { pk, permission } }), b),
        deleteKey: (account: string, pk: string) => (tx.actions.push({ deleteKey: { account, pk } }), b),
        send: async (o: { waitUntil?: string } = {}) => {
          tx.waitUntil = o.waitUntil;
          sent.push(tx);
          return outcome;
        },
      };
      return b;
    },
  };
  return { near: near as unknown as Near, sent };
}

/** A client whose RPC answers from `answer`, recording every request. */
function withRpc(client: AttestraClient, answer: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: Array<Record<string, unknown>> = [];
  client.rpc = (async (method: string, params: Record<string, unknown>) => {
    calls.push(params);
    return answer(method, params);
  }) as AttestraClient['rpc'];
  return calls;
}

const keyList = {
  keys: [
    { public_key: 'ed25519:full', access_key: { nonce: 1, permission: 'FullAccess' as const } },
    { public_key: KEY, access_key: { nonce: 2, permission: { FunctionCall: { allowance: '250000000000000000000000', receiver_id: ATT, method_names: ['attest', 'revoke'] } } } },
    { public_key: OTHER, access_key: { nonce: 3, permission: { FunctionCall: { allowance: null, receiver_id: 'app.testnet', method_names: [] } } } },
  ],
};

describe('agent key helpers', () => {
  it('parses NEAR amounts exactly', () => {
    expect(nearToYocto('0.25')).toBe(25n * 10n ** 22n);
    expect(nearToYocto('1')).toBe(10n ** 24n);
    expect(nearToYocto('0.000000000000000000000001')).toBe(1n);
    for (const bad of ['', '-1', '1e3', '0.0000000000000000000000001', 'one', '1.']) expect(() => nearToYocto(bad)).toThrow(/must be an amount of NEAR/);
  });

  it('defaults to the attest and revoke family with 0.25 NEAR, and never to every method', () => {
    expect(agentKeyGrant(KEY)).toEqual({ methodNames: [...AGENT_KEY_METHODS], allowance: 25n * 10n ** 22n });
    expect(agentKeyGrant(KEY, { methods: ['attest', ' attest ', 'revoke_on_behalf'], allowanceNear: '0.1' }).methodNames).toEqual(['attest', 'revoke_on_behalf']);
    expect(() => agentKeyGrant(KEY, { methods: [] })).toThrow(/at least one method/);
    expect(() => agentKeyGrant(KEY, { methods: [''] })).toThrow(/at least one method/);
    expect(() => agentKeyGrant(KEY, { allowanceNear: '0' })).toThrow(/more than 0/);
    expect(() => agentKeyGrant('not-a-key')).toThrow(/public key/);
  });

  it('refuses storage, delegation, signer key and owner methods', () => {
    for (const m of ['storage_withdraw', 'storage_deposit', 'add_delegate', 'add_signer_key', 'register_authority', 'set_governance', 'propose', 'on_resolver_verdict']) {
      expect(AGENT_KEY_GRANTABLE_METHODS as readonly string[]).not.toContain(m);
      expect(() => agentKeyGrant(KEY, { methods: ['attest', m] })).toThrow(new RegExp(`does not allow ${m}`));
    }
  });

  it('keeps only function-call keys for the attestations contract', () => {
    expect(agentKeysFrom(keyList, ATT)).toEqual([{ publicKey: KEY, receiverId: ATT, methodNames: ['attest', 'revoke'], allowance: '250000000000000000000000' }]);
    expect(agentKeysFrom({}, ATT)).toEqual([]);
  });
});

describe('AttestraClient agent keys', () => {
  it('grants a function-call key on the attestations contract', async () => {
    const { near, sent } = fakeNear();
    const client = new AttestraClient({ network: 'testnet', accountId: 'owner.testnet', near });
    const r = await client.grantAgentKey(KEY, { methods: ['attest'], allowanceNear: '0.5' });
    expect(r).toEqual({ success: true, data: { publicKey: KEY, receiverId: ATT, methodNames: ['attest'], allowance: '500000000000000000000000' }, txHash: 'TXH' });
    expect(sent).toEqual([
      { signer: 'owner.testnet', waitUntil: 'EXECUTED_OPTIMISTIC', actions: [{ addKey: { pk: KEY, permission: { type: 'functionCall', receiverId: ATT, methodNames: ['attest'], allowance: 5n * 10n ** 23n } } }] },
    ]);
  });

  it('checks the grant before the signer, and needs a signer to send', async () => {
    const client = new AttestraClient({ network: 'testnet' });
    expect((await client.grantAgentKey(KEY, { methods: ['storage_withdraw'] })).error?.type).toBe('VALIDATION_ERROR');
    expect((await client.grantAgentKey(KEY)).error?.type).toBe('CONFIGURATION_ERROR');
  });

  it('reports a failed transaction and a key that already exists', async () => {
    const { near } = fakeNear({ status: { Failure: { ActionError: { kind: { AddKeyAlreadyExists: { public_key: KEY } } } } } });
    const client = new AttestraClient({ network: 'testnet', accountId: 'owner.testnet', near });
    const r = await client.grantAgentKey(KEY);
    expect(r.success).toBe(false);
    expect(r.error?.type).toBe('ALREADY_EXISTS');
  });

  it('deletes only agent keys of the attestations contract', async () => {
    const { near, sent } = fakeNear();
    const client = new AttestraClient({ network: 'testnet', accountId: 'owner.testnet', near });
    const perms: Record<string, unknown> = { [KEY]: keyList.keys[1].access_key, [OTHER]: keyList.keys[2].access_key, 'ed25519:full': keyList.keys[0].access_key };
    const calls = withRpc(client, (_m, p) => perms[String(p.public_key)] ?? { error: `access key ${p.public_key} does not exist while viewing` });
    const ok = await client.revokeAgentKey(KEY);
    expect(ok).toEqual({ success: true, data: undefined, txHash: 'TXH' });
    expect(calls[0]).toMatchObject({ request_type: 'view_access_key', account_id: 'owner.testnet', public_key: KEY });
    expect(sent[0].actions).toEqual([{ deleteKey: { account: 'owner.testnet', pk: KEY } }]);

    for (const k of ['ed25519:full', OTHER]) {
      const r = await client.revokeAgentKey(k);
      expect(r.error?.type).toBe('VALIDATION_ERROR');
      expect(r.error?.message).toMatch(/not an agent key/);
    }
    expect((await client.revokeAgentKey('ed25519:gone')).error?.type).toBe('NOT_FOUND');
    expect(sent.length).toBe(1);
  });

  it('lists the agent keys of an account', async () => {
    const client = new AttestraClient({ network: 'testnet' });
    const calls = withRpc(client, () => keyList);
    const r = await client.agentKeys('owner.testnet');
    expect(r.data?.keys.map((k) => k.publicKey)).toEqual([KEY]);
    expect(calls[0]).toEqual({ request_type: 'view_access_key_list', finality: 'optimistic', account_id: 'owner.testnet' });
  });
});

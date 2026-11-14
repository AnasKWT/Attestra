import { keySigner, signRequest, type DelegatedAction, type SignedRequest } from 'attestra';
import { Near, generateKey, type PrivateKey } from 'near-kit';
import { describe, expect, it } from 'vitest';
import { DailyLedger } from '../src/lib/ledger';
import { RecentErrors } from '../src/lib/log';
import { parseNear } from '../src/lib/units';
import { createRelayerApp } from '../src/relayer/app';
import { loadRelayerConfig } from '../src/relayer/config';
import { checkMeta, metaReceivers } from '../src/relayer/meta';
import { RelayerPolicy, STORAGE_TOP_UP, checkSignedRequest, isImplicitOf, storageTopUp } from '../src/relayer/policy';
import { FakeReader, FakeWriter, panic, quietLog } from './fakes';

const NOW = 1_800_000_000;
const A = 'attestations.attestra.testnet';
const SCHEMA = 'ab'.repeat(32);
const alice = generateKey();
const signer = keySigner(alice.secretKey);

const attest = (over: Partial<DelegatedAction> = {}): DelegatedAction =>
  ({ action: 'attest', attester: 'alice.testnet', schema_uid: SCHEMA, subject: 'bob.testnet', data: 'AQID', deadline: NOW + 600, ...over }) as DelegatedAction;
const signed = (action: DelegatedAction = attest(), recipient = A) => signRequest(signer, action, recipient);

describe('signed request checks', () => {
  it('accepts a real keySigner signature for an attest and a revoke', async () => {
    const r = checkSignedRequest(await signed(), A, NOW);
    expect(r.ok).toBe(true);
    const revoke = checkSignedRequest(await signed({ action: 'revoke', attester: 'alice.testnet', uid: 'cd'.repeat(32), deadline: NOW + 5 } as DelegatedAction), A, NOW);
    expect(revoke.ok).toBe(true);
  });

  it('refuses a bad signature with 401', async () => {
    const req = await signed();
    const tampered: SignedRequest = { ...req, message: req.message.replace('bob.testnet', 'eve.testnet') };
    expect(checkSignedRequest(tampered, A, NOW)).toMatchObject({ ok: false, status: 401 });
    const otherRecipient = await signed(attest(), 'attestations.other.testnet');
    expect(checkSignedRequest(otherRecipient, A, NOW)).toMatchObject({ ok: false, status: 401 });
    const otherKey = keySigner(generateKey().secretKey);
    const wrongKey = { ...req, public_key: otherKey.publicKey };
    expect(checkSignedRequest(wrongKey, A, NOW)).toMatchObject({ ok: false, status: 401 });
    expect(checkSignedRequest({ ...req, signature: '!!!' }, A, NOW)).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a past deadline, an unknown action and malformed input with 400', async () => {
    expect(checkSignedRequest(await signed(attest({ deadline: NOW - 1 })), A, NOW)).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/expired/) });
    expect(checkSignedRequest(await signed({ action: 'delete', attester: 'alice.testnet', deadline: NOW + 9 } as unknown as DelegatedAction), A, NOW)).toMatchObject({ status: 400 });
    expect(checkSignedRequest(await signed(attest({ attester: 'Not An Account' })), A, NOW)).toMatchObject({ status: 400 });
    expect(checkSignedRequest(await signed(attest({ schema_uid: 'xyz' })), A, NOW)).toMatchObject({ status: 400 });
    expect(checkSignedRequest(undefined, A, NOW)).toMatchObject({ status: 400 });
    expect(checkSignedRequest({ message: 'x' }, A, NOW)).toMatchObject({ status: 400 });
    expect(checkSignedRequest({ ...(await signed()), message: 'not json' }, A, NOW)).toMatchObject({ status: 400 });
  });

  it('recognises implicit accounts', () => {
    const hex = Buffer.from(alice.publicKey.data).toString('hex');
    expect(isImplicitOf(hex, alice.publicKey.toString())).toBe(true);
    expect(isImplicitOf('alice.testnet', alice.publicKey.toString())).toBe(false);
  });
});

describe('policy', () => {
  const cfg = { allowlist: new Set<string>(), dailyPerAttester: 2, dailyTotal: 3, storageBudget: parseNear('0.05'), metaDailyPerSender: 1, metaDailyTotal: 5 };

  it('decides the storage top-up from the available balance', () => {
    expect(storageTopUp(null)).toBe(STORAGE_TOP_UP);
    expect(storageTopUp({ total: '1', available: String(parseNear('0.009')) })).toBe(STORAGE_TOP_UP);
    expect(storageTopUp({ total: '1', available: String(parseNear('0.01')) })).toBe(0n);
    expect(STORAGE_TOP_UP).toBe(parseNear('0.02'));
  });

  it('applies the allowlist (empty means open)', () => {
    expect(new RelayerPolicy(cfg, new DailyLedger(null)).allows('anyone.testnet')).toBe(true);
    const closed = new RelayerPolicy({ ...cfg, allowlist: new Set(['alice.testnet']) }, new DailyLedger(null));
    expect(closed.allows('alice.testnet')).toBe(true);
    expect(closed.allows('eve.testnet')).toBe(false);
  });

  it('enforces the per-attester, global, storage and meta budgets', () => {
    const p = new RelayerPolicy(cfg, new DailyLedger(null));
    expect(p.takeSubmission('a.testnet')).toBeNull();
    expect(p.takeSubmission('a.testnet')).toBeNull();
    expect(p.takeSubmission('a.testnet')).toMatch(/a.testnet reached its daily budget/);
    expect(p.takeSubmission('b.testnet')).toBeNull();
    expect(p.takeSubmission('c.testnet')).toMatch(/relayer reached its daily submission budget/);
    expect(p.takeStorage(parseNear('0.02'))).toBe(true);
    expect(p.takeStorage(parseNear('0.02'))).toBe(true);
    expect(p.takeStorage(parseNear('0.02'))).toBe(false);
    expect(p.takeMeta('s.testnet')).toBeNull();
    expect(p.takeMeta('s.testnet')).toMatch(/meta-transactions/);
    expect(p.usage().submissions).toMatchObject({ used: 3, limit: 3 });
  });
});

describe('meta transactions', () => {
  const config = loadRelayerConfig({});
  const allowed = metaReceivers(config.net);
  const near = new Near({ network: { rpcUrl: 'http://127.0.0.1:9', networkId: 'testnet' }, privateKey: alice.secretKey as PrivateKey, defaultSignerId: 'alice.testnet' });
  const delegate = async (receiver: string, transfer = false) => {
    let tx = near.transaction('alice.testnet');
    tx = transfer ? tx.transfer(receiver, '1 yocto') : tx.functionCall(receiver, 'ft_transfer', { receiver_id: 'x.testnet', amount: '1' }, { gas: '30 Tgas', attachedDeposit: '1 yocto' });
    return (await tx.delegate({ nonce: 7n, maxBlockHeight: 10_000n, publicKey: alice.publicKey.toString() })).payload;
  };

  it('allows only Attestra contracts and the payment token', async () => {
    expect(allowed.has(config.net.paymentToken)).toBe(true);
    expect(allowed.has('attestations.attestra.testnet')).toBe(true);
    expect(allowed.has('whitelist.attestra.testnet')).toBe(true);
    const ok = checkMeta(await delegate(config.net.paymentToken), allowed);
    expect(ok).toMatchObject({ ok: true, value: { sender: 'alice.testnet', receiver: config.net.paymentToken, methods: ['ft_transfer'], publicKey: alice.publicKey.toString() } });
    expect(checkMeta(await delegate('usdc.fakes.testnet'), allowed)).toMatchObject({ ok: false, status: 403 });
    expect(checkMeta(await delegate('attestations.attestra.testnet', true), allowed)).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses garbage and a forged signature', async () => {
    expect(checkMeta('', allowed)).toMatchObject({ status: 400 });
    expect(checkMeta('bm90IGEgZGVsZWdhdGU=', allowed)).toMatchObject({ status: 400 });
    const bytes = Buffer.from(await delegate(config.net.paymentToken), 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    expect(checkMeta(bytes.toString('base64'), allowed)).toMatchObject({ ok: false, status: 401 });
  });
});

function relayer(over: { idle?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const config = loadRelayerConfig({ RELAYER_DAILY_PER_ATTESTER: '2', RELAYER_STORAGE_BUDGET_NEAR: '0.04', ...over.env });
  const reader = new FakeReader();
  reader.balances.set(config.accountId, parseNear('5'));
  reader.setView(A, 'get_signer_keys', 'alice.testnet', [signer.publicKey]);
  const writer = over.idle ? null : new FakeWriter(config.accountId);
  const errors = new RecentErrors();
  const log = quietLog();
  const app = createRelayerApp({ config: over.idle ? { ...config, idleReason: 'RELAYER_PRIVATE_KEY is not set: idle, read-only mode' } : config, reader, writer, policy: new RelayerPolicy(config, new DailyLedger(null)), log, errors, nowSecs: () => NOW });
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { app, reader, writer, log, errors, post };
}

describe('relayer API', () => {
  it('submits with 300 Tgas and attaches 0.02 NEAR when the storage balance is low', async () => {
    const r = relayer();
    const res = await r.post('/v1/submit', { request: await signed() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: { uid: 'u', status: 'created' }, tx_hash: 'tx1' });
    expect(r.writer!.sent[0]).toMatchObject({ receiver: A, method: 'submit_signed', deposit: parseNear('0.02'), gas: 300n * 10n ** 12n });
    expect(r.log.lines.some((l) => /submit attest for alice.testnet: created/.test(l))).toBe(true);

    r.reader.setView(A, 'storage_balance_of', 'alice.testnet', { total: '1', available: String(parseNear('1')) });
    await r.post('/v1/submit', { request: await signed() });
    expect(r.writer!.sent[1].deposit).toBe(0n);
  });

  it('answers 4xx for policy and validation failures without sending', async () => {
    const closed = relayer({ env: { RELAYER_ALLOWLIST: 'carol.testnet, dave.testnet' } });
    expect((await closed.post('/v1/submit', { request: await signed() })).status).toBe(403);

    const r = relayer();
    expect((await r.post('/v1/submit', { request: await signed(attest({ deadline: NOW - 10 })) })).status).toBe(400);
    expect((await r.post('/v1/submit', { nope: 1 })).status).toBe(400);
    r.reader.setView(A, 'get_signer_keys', 'alice.testnet', []);
    expect((await r.post('/v1/submit', { request: await signed() })).status).toBe(401);
    expect(r.writer!.sent).toHaveLength(0);
  });

  it('enforces the daily per-attester budget and the storage budget', async () => {
    const r = relayer();
    expect((await r.post('/v1/submit', { request: await signed() })).status).toBe(200);
    expect((await r.post('/v1/submit', { request: await signed() })).status).toBe(200);
    const third = await r.post('/v1/submit', { request: await signed() });
    expect(third.status).toBe(429);
    expect(r.writer!.sent).toHaveLength(2);

    const s = relayer({ env: { RELAYER_DAILY_PER_ATTESTER: '50' } });
    await s.post('/v1/submit', { request: await signed() });
    await s.post('/v1/submit', { request: await signed() });
    const over = await s.post('/v1/submit', { request: await signed() });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: expect.stringMatching(/storage budget/) });
  });

  it('answers 502 with the panic on a chain failure and records it', async () => {
    const r = relayer();
    r.writer!.respond = () => {
      throw panic('this signed request was already used');
    };
    const res = await r.post('/v1/submit', { request: await signed() });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'this signed request was already used' });
    expect(r.errors.list()[0].message).toMatch(/already used/);
  });

  it('relays an allowed meta transaction and refuses others', async () => {
    const r = relayer();
    const config = loadRelayerConfig({});
    const near = new Near({ network: { rpcUrl: 'http://127.0.0.1:9', networkId: 'testnet' }, privateKey: alice.secretKey as PrivateKey, defaultSignerId: 'alice.testnet' });
    const make = async (receiver: string) =>
      (await near.transaction('alice.testnet').functionCall(receiver, 'ft_transfer', {}, { gas: '30 Tgas', attachedDeposit: '1 yocto' }).delegate({ nonce: 1n, maxBlockHeight: 99n, publicKey: alice.publicKey.toString() })).payload;
    r.reader.keys.set('alice.testnet', [alice.publicKey.toString()]);
    r.writer!.respond = () => null;
    const ok = await r.post('/v1/meta', { signed_delegate: await make(config.net.paymentToken) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ tx_hash: 'tx1', outcome: null });
    expect((await r.post('/v1/meta', { signed_delegate: await make('evil.testnet') })).status).toBe(403);
    r.reader.keys.set('alice.testnet', []);
    expect((await r.post('/v1/meta', { signed_delegate: await make(config.net.paymentToken) })).status).toBe(401);
    expect(r.writer!.sent).toHaveLength(1);
  });

  it('sponsors 0.05 NEAR of storage once per account and day', async () => {
    const r = relayer({ env: { RELAYER_STORAGE_BUDGET_NEAR: '1' } });
    r.writer!.respond = () => ({ total: '5', available: '5' });
    const res = await r.post('/v1/sponsor-storage', { account_id: 'newbie.testnet', contract: 'schemas' });
    expect(res.status).toBe(200);
    expect(r.writer!.sent[0]).toMatchObject({ receiver: 'schemas.attestra.testnet', method: 'storage_deposit', deposit: parseNear('0.05'), args: { account_id: 'newbie.testnet' } });
    expect((await r.post('/v1/sponsor-storage', { account_id: 'newbie.testnet', contract: 'schemas' })).status).toBe(429);
    expect((await r.post('/v1/sponsor-storage', { account_id: 'newbie.testnet', contract: 'nope' })).status).toBe(400);
    r.reader.setView('attestations.attestra.testnet', 'storage_balance_of', 'rich.testnet', { total: '1', available: String(parseNear('1')) });
    expect(await (await r.post('/v1/sponsor-storage', { account_id: 'rich.testnet', contract: 'attestations' })).json()).toMatchObject({ deposited: '0' });
  });

  it('funds a new passkey account once, and only implicit accounts', async () => {
    const r = relayer({ env: { RELAYER_STORAGE_BUDGET_NEAR: '1' } });
    const id = 'ab'.repeat(32);
    const res = await r.post('/v1/passkey-account', { account_id: id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: true, account_id: id });
    expect(r.writer!.sent[0]).toMatchObject({ kind: 'transfer', receiver: id, amount: parseNear('0.05') });
    expect((await r.post('/v1/passkey-account', { account_id: id })).status).toBe(429);
    expect((await r.post('/v1/passkey-account', { account_id: 'named.testnet' })).status).toBe(400);
    r.reader.balances.set('cd'.repeat(32), 10n);
    expect(await (await r.post('/v1/passkey-account', { account_id: 'cd'.repeat(32) })).json()).toMatchObject({ created: false });
    expect(r.writer!.sent).toHaveLength(1);
  });

  it('shows balance, budgets, queue and gas key use in /health', async () => {
    const r = relayer();
    const res = await r.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: 'active', balance_near: '5', gas_key: false, queue: { length: 0, lanes: 1 }, budgets: { submissions: { used: 0, limit: 500 } } });
  });

  it('runs idle without a key: /live ok, /health 503 with the reason, writes refused', async () => {
    const r = relayer({ idle: true });
    expect(await (await r.app.request('/live')).json()).toEqual({ ok: true });
    const health = await r.app.request('/health');
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, mode: 'idle', reason: expect.stringMatching(/RELAYER_PRIVATE_KEY/) });
    expect((await r.post('/v1/submit', { request: await signed() })).status).toBe(503);
    expect((await r.app.request('/nope')).status).toBe(404);
  });
});

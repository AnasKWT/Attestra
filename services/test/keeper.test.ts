import type { AttestationRecord } from 'attestra';
import { describe, expect, it } from 'vitest';
import { RecentErrors } from '../src/lib/log';
import { createKeeperApp } from '../src/keeper/app';
import { loadKeeperConfig } from '../src/keeper/config';
import { Keeper } from '../src/keeper/keeper';
import { alreadyDone, compareRecord, dueRevocations, expiredCandidates, notYet } from '../src/keeper/select';
import { FakeIndexer, FakeReader, FakeWriter, attestation, event, panic, quietLog } from './fakes';

const NOW = 1_800_000_000;
const A = 'attestations.attestra.testnet';
const uid = (c: string) => c.repeat(64);

const chainOf = (row: ReturnType<typeof attestation>): AttestationRecord => {
  const { tx_hash: _t, block_height: _b, revoke_tx_hash: _r, ...rest } = row;
  return rest;
};

describe('keeper selection', () => {
  it('finalizes only due scheduled revocations without a revoke event', () => {
    const rows = [
      attestation(uid('1'), { status: 'revoked', revoked: true, revoke_at: NOW - 10 }),
      attestation(uid('2'), { status: 'revoked', revoked: true, revoke_at: NOW - 10, revoke_tx_hash: 'done' }),
      attestation(uid('3'), { status: 'revoked', revoked: true, revoke_at: 0, revocation_time: NOW - 50 }),
      attestation(uid('4'), { status: 'active', revoke_at: NOW + 100 }),
      attestation(uid('5'), { status: 'revoked', revoked: true, revoke_at: NOW }),
    ];
    expect(dueRevocations(rows, NOW)).toEqual([uid('1'), uid('5')]);
    expect(dueRevocations(rows, NOW, (u) => u === uid('5'))).toEqual([uid('1')]);
  });

  it('records expiry only for expired, unrevoked attestations', () => {
    const rows = [
      attestation(uid('a'), { status: 'expired', expiration_time: NOW - 1 }),
      attestation(uid('b'), { status: 'expired', expiration_time: NOW }),
      attestation(uid('c'), { status: 'active', expiration_time: 0 }),
      attestation(uid('d'), { status: 'revoked', revoked: true, expiration_time: NOW - 5 }),
    ];
    expect(expiredCandidates(rows, NOW)).toEqual([uid('a')]);
  });

  it('reads "already done" and "not yet" panics', () => {
    expect(alreadyDone('expiry', 'expiry already recorded')).toBe(true);
    expect(alreadyDone('finalize', 'already revoked')).toBe(true);
    expect(alreadyDone('expiry', 'already revoked')).toBe(false);
    expect(notYet('no revocation is due')).toBe(true);
    expect(notYet('the attestation has not expired')).toBe(true);
  });

  it('detects drift in status, revoked, revoke_at and missing records', () => {
    const row = attestation(uid('e'));
    expect(compareRecord(row, chainOf(row), NOW)).toEqual([]);
    expect(compareRecord(row, null, NOW)).toEqual([{ uid: uid('e'), field: 'exists', indexer: true, chain: false }]);
    const drift = compareRecord(row, { ...chainOf(row), status: 'revoked', revoked: true, revoke_at: NOW - 1000 }, NOW);
    expect(drift.map((d) => d.field).sort()).toEqual(['revoke_at', 'revoked', 'status']);
    // Within the grace window around a scheduled time, only revoke_at is compared.
    const scheduled = attestation(uid('f'), { revoke_at: NOW - 5 });
    expect(compareRecord(scheduled, { ...chainOf(scheduled), status: 'revoked', revoked: true }, NOW)).toEqual([]);
  });
});

function setup(opts: { idle?: boolean } = {}) {
  const config = loadKeeperConfig({ KEEPER_INTERVAL_MS: '30000' });
  const indexer = new FakeIndexer();
  const reader = new FakeReader();
  const writer = opts.idle ? null : new FakeWriter(config.accountId);
  const errors = new RecentErrors();
  const log = quietLog();
  const keeper = new Keeper({ config, indexer, reader, writer, log, errors, nowSecs: () => NOW });
  reader.balances.set(config.accountId, 10n ** 24n);
  const app = createKeeperApp({ config: opts.idle ? { ...config, idleReason: 'KEEPER_PRIVATE_KEY is not set: idle, read-only mode' } : config, keeper, reader, writer, errors });
  return { config, indexer, reader, writer, errors, log, keeper, app };
}

describe('keeper pass', () => {
  it('finalizes due revocations and records unrecorded expiries', async () => {
    const k = setup();
    k.indexer.rows = [
      attestation(uid('1'), { status: 'revoked', revoked: true, revoke_at: NOW - 60 }),
      attestation(uid('2'), { status: 'revoked', revoked: true, revoke_at: NOW - 60, revoke_tx_hash: 'x' }),
      attestation(uid('3'), { status: 'expired', expiration_time: NOW - 100 }),
      attestation(uid('4'), { status: 'expired', expiration_time: NOW - 100 }),
      attestation(uid('5'), { status: 'expired', expiration_time: NOW - 100 }),
    ];
    k.indexer.events.set(uid('4'), [event(uid('4'), 'attestation_expired')]);
    for (const r of k.indexer.rows) k.reader.setView(A, 'get_attestation', r.uid, chainOf(r));
    k.writer!.respond = (tx) => {
      if (tx.method === 'record_expiry' && tx.args?.uid === uid('5')) throw panic('expiry already recorded');
      return { uid: tx.args?.uid, status: tx.method === 'record_expiry' ? 'expired' : 'revoked' };
    };
    const report = await k.keeper.tick();
    expect(report.finalized).toEqual([uid('1')]);
    expect(report.recorded).toEqual([uid('3')]);
    expect(report.failed).toBe(0);
    expect(k.writer!.sent.map((t) => `${t.method}:${String(t.args?.uid)[0]}`)).toEqual(['finalize_revocation:1', 'record_expiry:3', 'record_expiry:5']);
    expect(k.writer!.sent.every((t) => t.receiver === A)).toBe(true);

    // The next pass skips what is done, even while the indexer still lags.
    k.writer!.sent = [];
    await k.keeper.tick();
    expect(k.writer!.sent).toEqual([]);
  });

  it('caps the transactions per pass', async () => {
    const k = setup();
    k.indexer.rows = Array.from({ length: 30 }, (_, i) => attestation(i.toString(16).padStart(64, '0'), { status: 'revoked', revoked: true, revoke_at: NOW - 1 }));
    await k.keeper.tick();
    expect(k.writer!.sent).toHaveLength(k.config.maxPerTick);
  });

  it('reports drift and lag in /health', async () => {
    const k = setup();
    const row = attestation(uid('9'));
    k.indexer.rows = [row];
    k.reader.setView(A, 'get_attestation', row.uid, { ...chainOf(row), status: 'revoked', revoked: true, revoke_at: NOW - 999 });
    await k.keeper.tick();
    let res = await k.app.request('/health');
    expect(res.status).toBe(503);
    let body = (await res.json()) as { reason: string; drift: unknown[] };
    expect(body.reason).toMatch(/drift/);
    expect(body.drift).toHaveLength(3);

    k.reader.setView(A, 'get_attestation', row.uid, chainOf(row));
    k.indexer.lag = 301;
    await k.keeper.tick();
    res = await k.app.request('/health');
    body = (await res.json()) as { reason: string; drift: unknown[] };
    expect(res.status).toBe(503);
    expect(body.reason).toMatch(/lag 301 blocks/);

    k.indexer.lag = 10;
    await k.keeper.tick();
    res = await k.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, mode: 'active', lag_blocks: 10, drift: [] });
  });

  it('survives an unreachable indexer and records the errors', async () => {
    const k = setup();
    k.indexer.fail = true;
    const report = await k.keeper.tick();
    expect(report.failed).toBeGreaterThan(0);
    expect(k.errors.list().length).toBeGreaterThan(0);
    expect((await k.app.request('/health')).status).toBe(503);
  });

  it('runs read-only without a key: drift check only, /live ok, /health 503', async () => {
    const k = setup({ idle: true });
    k.indexer.rows = [attestation(uid('1'), { status: 'revoked', revoked: true, revoke_at: NOW - 60 })];
    k.reader.setView(A, 'get_attestation', uid('1'), chainOf(k.indexer.rows[0]));
    const report = await k.keeper.tick();
    expect(report.finalized).toEqual([]);
    expect(report.checked).toBe(1);
    expect(await (await k.app.request('/live')).json()).toEqual({ ok: true });
    const res = await k.app.request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, mode: 'read-only', reason: expect.stringMatching(/KEEPER_PRIVATE_KEY/) });
  });

  it('limits POST /v1/run and POST /v1/dao/* per client address, never /health', async () => {
    const config = loadKeeperConfig({ KEEPER_RATE_RUN_IP: '2/1h', KEEPER_RATE_DAO_IP: '1/1h', TRUST_PROXY: '1' });
    const reader = new FakeReader();
    const errors = new RecentErrors();
    const keeper = new Keeper({ config, indexer: new FakeIndexer(), reader, writer: null, log: quietLog(), errors, nowSecs: () => NOW });
    const app = createKeeperApp({ config, keeper, reader, writer: null, errors });
    const run = (ip: string) => app.request('/v1/run', { method: 'POST', headers: { 'x-forwarded-for': ip } });
    expect((await run('203.0.113.1')).status).toBe(200);
    expect((await run('203.0.113.1')).status).toBe(200);
    const refused = await run('203.0.113.1');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1800');
    expect((await run('203.0.113.2')).status).toBe(200);
    const dao = () => app.request('/v1/dao/membership', { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '203.0.113.1' } });
    expect((await dao()).status).toBe(503);
    expect((await dao()).status).toBe(429);
    expect((await app.request('/v1/dao')).status).toBe(200);
    for (let i = 0; i < 5; i++) expect([200, 503]).toContain((await app.request('/health')).status);
  });
});

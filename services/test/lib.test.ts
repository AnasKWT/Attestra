import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '../src/lib/config';
import { DailyLedger } from '../src/lib/ledger';
import { LanePool, SerialQueue } from '../src/lib/queue';
import { formatNear, parseNear } from '../src/lib/units';
import { loadRelayerConfig } from '../src/relayer/config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('NEAR units', () => {
  it('parses and formats exactly', () => {
    expect(parseNear('0.02')).toBe(20n * 10n ** 21n);
    expect(parseNear(3)).toBe(3n * 10n ** 24n);
    expect(parseNear('1.000000000000000000000001')).toBe(10n ** 24n + 1n);
    expect(formatNear(parseNear('3.25'))).toBe('3.25');
    expect(formatNear(0n)).toBe('0');
    expect(() => parseNear('-1')).toThrow();
    expect(() => parseNear('abc')).toThrow();
  });
});

describe('config', () => {
  it('has public testnet defaults and goes idle without a key', () => {
    const c = loadServiceConfig('relayer', {});
    expect(c).toMatchObject({ network: 'testnet', root: 'attestra.testnet', accountId: 'relayer.attestra.testnet', port: 5200, indexerUrl: 'http://localhost:5100' });
    expect(c.privateKey).toBeUndefined();
    expect(c.idleReason).toMatch(/RELAYER_PRIVATE_KEY/);
    expect(loadServiceConfig('keeper', {}).port).toBe(5400);
    const t = loadServiceConfig('topup', {});
    expect(t).toMatchObject({ port: 5500, accountId: 'attestra-treasury.testnet' });
    expect(t.idleReason).toMatch(/TREASURY_PRIVATE_KEY/);
  });

  it('treats a malformed key as idle instead of crashing', () => {
    const c = loadServiceConfig('keeper', { KEEPER_PRIVATE_KEY: 'not-a-key' });
    expect(c.privateKey).toBeUndefined();
    expect(c.idleReason).toMatch(/not a valid/);
  });

  it('trusts X-Forwarded-For only with TRUST_PROXY, and names a bad rate setting', () => {
    expect(loadServiceConfig('relayer', {}).trustProxy).toBe(false);
    expect(loadServiceConfig('relayer', { TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(() => loadRelayerConfig({ RELAYER_RATE_IP: 'lots' })).toThrow(/^RELAYER_RATE_IP: a rate is a count per window/);
    expect(loadRelayerConfig({}).rates).toEqual({ requestsIp: { limit: 60, windowMs: 600_000 }, sponsorIp: { limit: 20, windowMs: 86_400_000 } });
  });

  it('follows ATTESTRA_ROOT', () => {
    const c = loadServiceConfig('relayer', { ATTESTRA_ROOT: 'demo.testnet' });
    expect(c.accountId).toBe('relayer.demo.testnet');
    expect(c.net.contracts.attestations).toBe('attestations.demo.testnet');
  });
});

describe('send queue', () => {
  it('never runs two sends at once, in order, even after a failure', async () => {
    const q = new SerialQueue();
    let running = 0;
    let max = 0;
    const order: number[] = [];
    const job = (i: number) => async () => {
      running++;
      max = Math.max(max, running);
      await sleep(Math.floor(Math.random() * 5));
      order.push(i);
      running--;
      if (i === 3) throw new Error('boom');
      return i;
    };
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => q.run(job(i))));
    expect(max).toBe(1);
    expect(order).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(results[3].status).toBe('rejected');
    expect(results[4]).toEqual({ status: 'fulfilled', value: 4 });
    expect(q.length).toBe(0);
  });

  it('gas key lanes run in parallel but one job per lane', async () => {
    const pool = new LanePool(3);
    const perLane = [0, 0, 0];
    const maxPerLane = [0, 0, 0];
    let running = 0;
    let max = 0;
    const used = new Set<number>();
    await Promise.all(
      Array.from({ length: 15 }, () =>
        pool.run(async (lane) => {
          used.add(lane);
          perLane[lane]++;
          running++;
          maxPerLane[lane] = Math.max(maxPerLane[lane], perLane[lane]);
          max = Math.max(max, running);
          await sleep(2);
          perLane[lane]--;
          running--;
        }),
      ),
    );
    expect(maxPerLane).toEqual([1, 1, 1]);
    expect(max).toBe(3);
    expect([...used].sort()).toEqual([0, 1, 2]);
    expect(new LanePool(0).size).toBe(1);
  });
});

describe('daily ledger', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists the day across restarts and resets on a new UTC day', () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const file = join(dir, 'nested', 'budgets.json');
    let now = new Date('2026-11-10T10:00:00Z');
    const a = new DailyLedger(file, () => now);
    expect(a.take([['k', 3n]], 2n)).toBeNull();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ day: '2026-11-10', counters: { k: '2' } });

    const b = new DailyLedger(file, () => now);
    expect(b.used('k')).toBe(2n);
    expect(b.take([['k', 3n]], 2n)).toBe('k');
    expect(b.take([['k', 3n]], 1n)).toBeNull();

    now = new Date('2026-11-11T00:00:01Z');
    const c = new DailyLedger(file, () => now);
    expect(c.used('k')).toBe(0n);
    expect(b.used('k')).toBe(0n);
  });

  it('takes from every key or none, and refunds', () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const l = new DailyLedger(null);
    expect(l.take([['a', 5n], ['total', 1n]], 1n)).toBeNull();
    expect(l.take([['a', 5n], ['total', 1n]], 1n)).toBe('total');
    expect(l.used('a')).toBe(1n);
    l.refund(['a', 'total'], 1n);
    expect(l.used('a')).toBe(0n);
    l.refund(['a'], 5n);
    expect(l.used('a')).toBe(0n);
  });

  it('starts fresh from an unreadable file', () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const file = join(dir, 'b.json');
    writeFileSync(file, '{not json');
    expect(new DailyLedger(file).used('x')).toBe(0n);
  });
});

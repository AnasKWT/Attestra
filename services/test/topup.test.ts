import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DailyLedger } from '../src/lib/ledger';
import { RecentErrors } from '../src/lib/log';
import { parseNear as n } from '../src/lib/units';
import { createTopUpApp } from '../src/topup/app';
import { loadTopUpConfig, parseAccounts } from '../src/topup/config';
import { planTopUps, type Reading } from '../src/topup/plan';
import { TopUp } from '../src/topup/topup';
import { FakeReader, FakeWriter, quietLog } from './fakes';

const acct = (account: string, min: string, target: string, balance: bigint | null, extra: Partial<Reading> = {}): Reading => ({ kind: 'account', account, min: n(min), target: n(target), balance, ...extra });
const base = { dailyUsed: 0n, dailyCap: n('10'), warn: n('15'), reserve: n('0.5'), treasury: n('100') };

describe('top-up config', () => {
  it('has the documented defaults', () => {
    const c = loadTopUpConfig({});
    expect(c.watches.map((w) => `${w.kind}:${w.account}:${w.min / 10n ** 21n}:${w.target / 10n ** 21n}`)).toEqual([
      'account:relayer.attestra.testnet:3000:6000',
      'account:keeper.attestra.testnet:1000:2000',
      'account:agent.attestra.testnet:2000:4000',
      'storage:verdicts.attestra.testnet:300:1000',
    ]);
    expect(c.watches[3].contract).toBe('attestations.attestra.testnet');
    expect(c).toMatchObject({ accountId: 'attestra-treasury.testnet', intervalMs: 600_000, dailyCap: n('10'), treasuryWarn: n('15') });
  });

  it('parses account:min:target triples and rejects bad ones', () => {
    expect(parseAccounts('a.testnet:1:2, b.testnet:0.5:0.75')).toHaveLength(2);
    expect(() => parseAccounts('a.testnet:1')).toThrow();
    expect(() => parseAccounts('a.testnet:2:1')).toThrow(/target below min/);
    expect(() => parseAccounts('Bad Name:1:2')).toThrow(/invalid account/);
  });
});

describe('top-up planning', () => {
  it('refills below-minimum balances up to their target', () => {
    const plan = planTopUps({ ...base, readings: [acct('r.testnet', '3', '6', n('2.5')), acct('k.testnet', '1', '2', n('1.5')), acct('g.testnet', '2', '4', n('0'))] });
    expect(plan.refills).toEqual([
      { kind: 'account', account: 'r.testnet', amount: n('3.5'), partial: false },
      { kind: 'account', account: 'g.testnet', amount: n('4'), partial: false },
    ]);
    expect(plan.capLeft).toBe(n('2.5'));
    expect(plan.treasuryLow).toBe(false);
  });

  it('refills an unregistered storage balance from zero', () => {
    const plan = planTopUps({ ...base, readings: [{ kind: 'storage', account: 'verdicts.x.testnet', contract: 'attestations.x.testnet', min: n('0.3'), target: n('1'), balance: null }] });
    expect(plan.refills).toEqual([{ kind: 'storage', account: 'verdicts.x.testnet', contract: 'attestations.x.testnet', amount: n('1'), partial: false }]);
  });

  it('never goes over the daily cap', () => {
    const plan = planTopUps({ ...base, dailyUsed: n('7'), readings: [acct('r.testnet', '3', '6', n('1')), acct('k.testnet', '1', '2', n('0'))] });
    expect(plan.refills).toEqual([{ kind: 'account', account: 'r.testnet', amount: n('3'), partial: true }]);
    expect(plan.skipped).toEqual([{ account: 'k.testnet', kind: 'account', reason: 'daily cap reached' }]);
    expect(planTopUps({ ...base, dailyUsed: n('12'), readings: [acct('r.testnet', '3', '6', n('1'))] }).refills).toEqual([]);
  });

  it('keeps the treasury reserve and warns when the treasury is low', () => {
    const plan = planTopUps({ ...base, treasury: n('2'), readings: [acct('r.testnet', '3', '6', n('1')), acct('k.testnet', '1', '2', n('0'))] });
    expect(plan.refills).toEqual([{ kind: 'account', account: 'r.testnet', amount: n('1.5'), partial: true }]);
    expect(plan.skipped[0].reason).toBe('treasury too low');
    expect(plan.treasuryLow).toBe(true);
    expect(planTopUps({ ...base, treasury: null, readings: [acct('r.testnet', '3', '6', n('1'))] })).toMatchObject({ refills: [], treasuryLow: true });
    expect(planTopUps({ ...base, treasury: n('15'), readings: [] }).treasuryLow).toBe(false);
  });

  it('skips missing accounts and unreadable balances', () => {
    const plan = planTopUps({ ...base, readings: [acct('gone.testnet', '1', '2', null), acct('x.testnet', '1', '2', null, { error: 'fetch failed' })] });
    expect(plan.refills).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['account does not exist', 'balance unreadable: fetch failed']);
  });
});

describe('top-up service', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function setup(opts: { idle?: boolean; file?: string; env?: NodeJS.ProcessEnv } = {}) {
    const config = loadTopUpConfig({ TOPUP_DAILY_CAP_NEAR: '5', ...opts.env });
    const reader = new FakeReader();
    reader.balances.set(config.accountId, n('40'));
    reader.balances.set('relayer.attestra.testnet', n('1'));
    reader.balances.set('keeper.attestra.testnet', n('1.5'));
    reader.balances.set('agent.attestra.testnet', n('0.5'));
    reader.setView('attestations.attestra.testnet', 'storage_balance_of', 'verdicts.attestra.testnet', { total: String(n('1')), available: String(n('0.1')) });
    const writer = opts.idle ? null : new FakeWriter(config.accountId);
    const errors = new RecentErrors();
    const topup = new TopUp({ config, reader, writer, ledger: new DailyLedger(opts.file ?? null), log: quietLog(), errors });
    const app = createTopUpApp({ config: opts.idle ? { ...config, idleReason: 'TREASURY_PRIVATE_KEY is not set: idle, read-only mode' } : config, topup, writer, errors });
    return { config, reader, writer, topup, app };
  }

  it('sends refills from the treasury within the cap, and the cap survives a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'topup-'));
    const file = join(dir, 'topup-budget.json');
    const t = setup({ file });
    const report = await t.topup.run('test');
    expect(t.writer!.sent).toEqual([{ kind: 'transfer', receiver: 'relayer.attestra.testnet', amount: n('5') }]);
    expect(report.sent).toEqual([{ account: 'relayer.attestra.testnet', kind: 'account', amount_near: '5', tx_hash: 'tx1' }]);
    expect(report.skipped.map((s) => s.reason)).toEqual(['daily cap reached', 'daily cap reached']);

    const again = setup({ file });
    await again.topup.run('test');
    expect(again.writer!.sent).toEqual([]);
  });

  it('deposits storage for the verdicts contract with storage_deposit', async () => {
    const t = setup({ env: { TOPUP_DAILY_CAP_NEAR: '100' } });
    await t.topup.run('test');
    const storage = t.writer!.sent.find((s) => s.method === 'storage_deposit');
    expect(storage).toMatchObject({ kind: 'call', receiver: 'attestations.attestra.testnet', args: { account_id: 'verdicts.attestra.testnet' }, deposit: n('0.9') });
    expect(t.writer!.sent.filter((s) => s.kind === 'transfer').map((s) => [s.receiver, s.amount])).toEqual([
      ['relayer.attestra.testnet', n('5')],
      ['agent.attestra.testnet', n('3.5')],
    ]);
  });

  it('gives a failed refill back to the cap', async () => {
    const t = setup();
    t.writer!.respond = () => {
      throw new Error('fetch failed');
    };
    const report = await t.topup.run('test');
    expect(report.failed).toHaveLength(1);
    expect(t.topup.dailyUsed).toBe(0n);
  });

  it('serves /api/balances with mins, targets and the treasury warning', async () => {
    const t = setup();
    t.reader.balances.set(t.config.accountId, n('12'));
    const body = (await (await t.app.request('/api/balances')).json()) as Record<string, any>;
    expect(body.treasury).toMatchObject({ account: 'attestra-treasury.testnet', balance_near: '12', warn_near: '15', low: true });
    expect(body.treasury_low).toBe(true);
    expect(body.accounts[0]).toEqual({ account: 'relayer.attestra.testnet', balance_near: '1', min_near: '3', target_near: '6', below_min: true });
    expect(body.storage[0]).toMatchObject({ account: 'verdicts.attestra.testnet', contract: 'attestations.attestra.testnet', balance_near: '0.1', below_min: true });
    expect(body.daily).toMatchObject({ used_near: '0', cap_near: '5' });
  });

  it('runs idle without the treasury key: plans only, /live ok, /health 503', async () => {
    const t = setup({ idle: true });
    const report = await t.topup.run('test');
    expect(report.dry_run).toBe(true);
    expect(report.sent).toEqual([]);
    expect(await (await t.app.request('/live')).json()).toEqual({ ok: true });
    const res = await t.app.request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, mode: 'idle', reason: expect.stringMatching(/TREASURY_PRIVATE_KEY/) });
  });

  it('reports ok when everything is above minimum and the treasury is healthy', async () => {
    const t = setup();
    for (const a of ['relayer', 'keeper', 'agent']) t.reader.balances.set(`${a}.attestra.testnet`, n('9'));
    t.reader.setView('attestations.attestra.testnet', 'storage_balance_of', 'verdicts.attestra.testnet', { total: String(n('1')), available: String(n('1')) });
    const res = await t.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, treasury_low: false });
  });
});

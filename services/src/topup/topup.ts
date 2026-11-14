/** Reads every watched balance, plans the refills and sends them from the treasury. */

import { errorMessage, type StorageBalance } from 'attestra';
import { withTimeout, type ChainReader, type ChainWriter } from '../lib/chain';
import type { DailyLedger } from '../lib/ledger';
import type { Logger, RecentErrors } from '../lib/log';
import { TGAS, formatNear } from '../lib/units';
import type { TopUpConfig } from './config';
import { planTopUps, type Plan, type Reading } from './plan';

export const CAP_KEY = 'topup:yocto';

export interface Snapshot {
  at: string;
  readings: Reading[];
  treasury: bigint | null;
  treasuryError?: string;
}

export interface RunReport {
  at: string;
  trigger: string;
  sent: Array<{ account: string; kind: string; amount_near: string; tx_hash: string }>;
  skipped: Plan['skipped'];
  failed: Array<{ account: string; error: string }>;
  /** True in idle mode: the plan was computed but nothing was sent. */
  dry_run: boolean;
}

const SNAPSHOT_TTL_MS = 30_000;
const READ_TIMEOUT_MS = 8_000;

export class TopUp {
  lastRun: RunReport | null = null;
  private snapshot: Snapshot | null = null;
  private inFlight: Promise<RunReport> | null = null;

  constructor(
    private readonly deps: {
      config: TopUpConfig;
      reader: ChainReader;
      writer: ChainWriter | null;
      ledger: DailyLedger;
      log: Logger;
      errors: RecentErrors;
    },
  ) {}

  get dailyUsed(): bigint {
    return this.deps.ledger.used(CAP_KEY);
  }

  get day(): string {
    return this.deps.ledger.day;
  }

  async read(): Promise<Snapshot> {
    const { config, reader } = this.deps;
    const readings = await Promise.all(
      config.watches.map(async (w): Promise<Reading> => {
        try {
          if (w.kind === 'account') return { ...w, balance: await withTimeout(reader.balance(w.account), READ_TIMEOUT_MS, `${w.account} balance`) };
          const b = await withTimeout(
            reader.view<StorageBalance | null>(w.contract as string, 'storage_balance_of', { account_id: w.account }),
            READ_TIMEOUT_MS,
            `${w.account} storage balance`,
          );
          return { ...w, balance: b ? BigInt(b.available) : null };
        } catch (e) {
          return { ...w, balance: null, error: errorMessage(e) };
        }
      }),
    );
    let treasury: bigint | null = null;
    let treasuryError: string | undefined;
    try {
      treasury = await withTimeout(reader.balance(config.accountId), READ_TIMEOUT_MS, 'treasury balance');
      if (treasury === null) treasuryError = `${config.accountId} does not exist`;
    } catch (e) {
      treasuryError = errorMessage(e);
    }
    this.snapshot = { at: new Date().toISOString(), readings, treasury, ...(treasuryError ? { treasuryError } : {}) };
    return this.snapshot;
  }

  /** The latest readings, re-read when older than 30 seconds. */
  async current(): Promise<Snapshot> {
    if (this.snapshot && Date.now() - Date.parse(this.snapshot.at) < SNAPSHOT_TTL_MS) return this.snapshot;
    return this.read();
  }

  plan(s: Snapshot): Plan {
    const c = this.deps.config;
    return planTopUps({ readings: s.readings, treasury: s.treasury, dailyUsed: this.dailyUsed, dailyCap: c.dailyCap, warn: c.treasuryWarn, reserve: c.treasuryReserve });
  }

  /** One run; never throws. A call during a run gets that run's report. */
  run(trigger: string): Promise<RunReport> {
    this.inFlight ??= this.execute(trigger).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async execute(trigger: string): Promise<RunReport> {
    const { config, writer, ledger, log, errors } = this.deps;
    const snap = await this.read();
    const plan = this.plan(snap);
    const report: RunReport = { at: new Date().toISOString(), trigger, sent: [], skipped: plan.skipped, failed: [], dry_run: !writer };
    if (snap.treasuryError) errors.add(`treasury: ${snap.treasuryError}`);
    for (const r of snap.readings) if (r.error) errors.add(`${r.account}: ${r.error}`);
    for (const refill of plan.refills) {
      const what = `${refill.kind === 'storage' ? 'storage for ' : ''}${refill.account} +${formatNear(refill.amount)} NEAR${refill.partial ? ' (partial)' : ''}`;
      if (!writer) {
        log(`would refill ${what} (idle)`);
        continue;
      }
      if (ledger.take([[CAP_KEY, config.dailyCap]], refill.amount)) {
        report.skipped.push({ account: refill.account, kind: refill.kind, reason: 'daily cap reached' });
        continue;
      }
      try {
        const r =
          refill.kind === 'account'
            ? await writer.transfer(refill.account, refill.amount)
            : await writer.call(refill.contract as string, 'storage_deposit', { account_id: refill.account, registration_only: null }, { deposit: refill.amount, gas: 30n * TGAS });
        report.sent.push({ account: refill.account, kind: refill.kind, amount_near: formatNear(refill.amount), tx_hash: r.txHash });
        log(`refilled ${what} tx ${r.txHash}`);
      } catch (e) {
        ledger.refund([CAP_KEY], refill.amount);
        const error = errorMessage(e);
        report.failed.push({ account: refill.account, error });
        errors.add(`refill ${refill.account}: ${error}`);
        log(`refill ${what} failed: ${error}`);
      }
    }
    if (plan.treasuryLow) log(`treasury ${config.accountId} is low: ${snap.treasury === null ? 'unreadable' : `${formatNear(snap.treasury)} NEAR`} (warn below ${formatNear(config.treasuryWarn)})`);
    if (report.sent.length) await this.read();
    log(`run (${trigger}): ${report.sent.length} sent, ${report.skipped.length} skipped, ${report.failed.length} failed`);
    this.lastRun = report;
    return report;
  }
}

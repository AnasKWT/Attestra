/**
 * One keeper pass: finalize due scheduled revocations, record expiries, and compare the indexer
 * with the chain. Without a key it only runs the drift check.
 */

import { errorMessage, normalizeUid, type AttestationRecord, type IndexedAttestation, type IndexedEvent, type IndexerStatus, type Paginated } from 'attestra';
import type { ChainReader, ChainWriter } from '../lib/chain';
import type { Logger, RecentErrors } from '../lib/log';
import { TGAS } from '../lib/units';
import type { KeeperConfig } from './config';
import { alreadyDone, compareRecord, dueRevocations, expiredCandidates, notYet, type Drift } from './select';

/** The indexer API the keeper reads (the SDK's `IndexerClient` fits). */
export interface KeeperIndexer {
  listAttestations(q: { status?: string; limit?: number; offset?: number }): Promise<Paginated<IndexedAttestation>>;
  listEvents(q: { event?: string; uid?: string; limit?: number }): Promise<Paginated<IndexedEvent>>;
  status(): Promise<IndexerStatus>;
}

export interface TickReport {
  at: string;
  finalized: string[];
  recorded: string[];
  failed: number;
  drift: Drift[];
  checked: number;
  lag_blocks: number | null;
}

const PAGE = 100;
const MAX_PAGES = 5;
const KEEPER_GAS = 50n * TGAS;
/** Skip a finalized uid this long, while the indexer catches up with the event. */
const RECHECK_MS = 10 * 60_000;

export class Keeper {
  last: TickReport | null = null;
  lastDriftAt: string | null = null;
  private inFlight: Promise<TickReport> | null = null;
  private readonly finalized = new Map<string, number>();
  private readonly recorded = new Set<string>();

  constructor(
    private readonly deps: {
      config: KeeperConfig;
      indexer: KeeperIndexer;
      reader: ChainReader;
      writer: ChainWriter | null;
      log: Logger;
      errors: RecentErrors;
      nowSecs?: () => number;
      nowMs?: () => number;
    },
  ) {}

  private nowSecs() {
    return this.deps.nowSecs?.() ?? Math.floor(Date.now() / 1000);
  }

  private nowMs() {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private async list(status: string): Promise<IndexedAttestation[]> {
    const rows: IndexedAttestation[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.deps.indexer.listAttestations({ status, limit: PAGE, offset: page * PAGE });
      rows.push(...r.data);
      if (r.data.length < PAGE || rows.length >= r.pagination.total) break;
    }
    return rows;
  }

  private fail(what: string, e: unknown) {
    const message = `${what}: ${errorMessage(e)}`;
    this.deps.errors.add(message);
    this.deps.log(message);
  }

  /** One pass; never throws. A call during a pass gets that pass' report. */
  tick(): Promise<TickReport> {
    this.inFlight ??= this.pass().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pass(): Promise<TickReport> {
    const report: TickReport = { at: new Date(this.nowMs()).toISOString(), finalized: [], recorded: [], failed: 0, drift: [], checked: 0, lag_blocks: null };
    const writer = this.deps.writer;
    let budget = this.deps.config.maxPerTick;
    if (writer) {
      budget = await this.finalizeDue(writer, report, budget);
      await this.recordExpiries(writer, report, budget);
    }
    await this.checkDrift(report);
    this.last = report;
    return report;
  }

  private async finalizeDue(writer: ChainWriter, report: TickReport, budget: number): Promise<number> {
    const now = this.nowMs();
    for (const [uid, until] of this.finalized) if (until < now) this.finalized.delete(uid);
    let uids: string[];
    try {
      uids = dueRevocations(await this.list('revoked'), this.nowSecs(), (u) => this.finalized.has(u));
    } catch (e) {
      this.fail(`listing revoked attestations from ${this.deps.config.indexerUrl}`, e);
      report.failed++;
      return budget;
    }
    for (const uid of uids.slice(0, budget)) {
      budget--;
      try {
        const r = await writer.call(this.deps.config.net.contracts.attestations, 'finalize_revocation', { uid: normalizeUid(uid) }, { gas: KEEPER_GAS });
        this.finalized.set(uid, now + RECHECK_MS);
        report.finalized.push(uid);
        this.deps.log(`finalize_revocation ${uid} tx ${r.txHash}`);
      } catch (e) {
        const msg = errorMessage(e);
        if (alreadyDone('finalize', msg)) {
          this.finalized.set(uid, now + RECHECK_MS);
          this.deps.log(`finalize_revocation ${uid}: already revoked`);
        } else if (notYet(msg)) {
          this.deps.log(`finalize_revocation ${uid}: not due yet on chain`);
        } else {
          report.failed++;
          this.fail(`finalize_revocation ${uid}`, e);
        }
      }
    }
    return budget;
  }

  private async recordExpiries(writer: ChainWriter, report: TickReport, budget: number): Promise<void> {
    let uids: string[];
    try {
      uids = expiredCandidates(await this.list('expired'), this.nowSecs(), (u) => this.recorded.has(u));
    } catch (e) {
      this.fail(`listing expired attestations from ${this.deps.config.indexerUrl}`, e);
      report.failed++;
      return;
    }
    for (const uid of uids) {
      if (budget <= 0) break;
      try {
        const events = await this.deps.indexer.listEvents({ event: 'attestation_expired', uid, limit: 1 });
        if (events.pagination.total > 0 || events.data.length > 0) {
          this.remember(uid);
          continue;
        }
      } catch (e) {
        this.fail(`reading expiry events of ${uid}`, e);
        report.failed++;
        continue;
      }
      budget--;
      try {
        const r = await writer.call(this.deps.config.net.contracts.attestations, 'record_expiry', { uid: normalizeUid(uid) }, { gas: KEEPER_GAS });
        this.remember(uid);
        report.recorded.push(uid);
        this.deps.log(`record_expiry ${uid} tx ${r.txHash}`);
      } catch (e) {
        const msg = errorMessage(e);
        if (alreadyDone('expiry', msg)) {
          this.remember(uid);
          this.deps.log(`record_expiry ${uid}: already recorded`);
        } else if (notYet(msg)) {
          this.deps.log(`record_expiry ${uid}: not expired yet on chain`);
        } else {
          report.failed++;
          this.fail(`record_expiry ${uid}`, e);
        }
      }
    }
  }

  private remember(uid: string) {
    if (this.recorded.size >= 50_000) this.recorded.clear();
    this.recorded.add(uid);
  }

  private async checkDrift(report: TickReport): Promise<void> {
    try {
      const status = await this.deps.indexer.status();
      report.lag_blocks = status.lag_blocks;
    } catch (e) {
      this.fail(`reading indexer status from ${this.deps.config.indexerUrl}`, e);
      report.failed++;
    }
    try {
      const newest = await this.deps.indexer.listAttestations({ limit: this.deps.config.driftSample, offset: 0 });
      const now = this.nowSecs();
      for (const row of newest.data) {
        const chain = await this.deps.reader.view<AttestationRecord | null>(this.deps.config.net.contracts.attestations, 'get_attestation', { uid: normalizeUid(row.uid) });
        report.drift.push(...compareRecord(row, chain, now));
        report.checked++;
      }
      this.lastDriftAt = report.at;
      const lag = report.lag_blocks === null ? 'unknown' : String(report.lag_blocks);
      this.deps.log(`drift check: ${report.checked} compared, ${report.drift.length} mismatches, indexer lag ${lag} blocks`);
      for (const d of report.drift) this.deps.errors.add(`drift ${d.uid} ${d.field}: indexer ${JSON.stringify(d.indexer)}, chain ${JSON.stringify(d.chain)}`);
    } catch (e) {
      this.fail(`drift check against ${this.deps.config.indexerUrl}`, e);
      report.failed++;
    }
  }
}

/**
 * Daily counters (submissions, NEAR spent) kept in a small JSON file, so a restart keeps the
 * day's counts. Days are UTC; a new day starts from zero.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface LedgerFile {
  day: string;
  counters: Record<string, string>;
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export class DailyLedger {
  private state: LedgerFile;

  /** `file` null keeps the counts in memory only (tests). */
  constructor(
    private readonly file: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = this.load();
  }

  get day(): string {
    this.roll();
    return this.state.day;
  }

  used(key: string): bigint {
    this.roll();
    return BigInt(this.state.counters[key] ?? '0');
  }

  /**
   * Takes `amount` from every `[key, limit]` pair, or from none of them when any would go over
   * its limit. Returns the key that refused, or null when it took.
   */
  take(pairs: Array<[key: string, limit: bigint]>, amount: bigint): string | null {
    this.roll();
    for (const [key, limit] of pairs) if (this.used(key) + amount > limit) return key;
    for (const [key] of pairs) this.state.counters[key] = String(this.used(key) + amount);
    this.save();
    return null;
  }

  /** Gives back an amount taken for something that did not happen. */
  refund(keys: string[], amount: bigint): void {
    this.roll();
    for (const key of keys) {
      const left = this.used(key) - amount;
      this.state.counters[key] = String(left > 0n ? left : 0n);
    }
    this.save();
  }

  snapshot(): { day: string; counters: Record<string, string> } {
    this.roll();
    return { day: this.state.day, counters: { ...this.state.counters } };
  }

  private roll(): void {
    const today = utcDay(this.now());
    if (this.state.day !== today) this.state = { day: today, counters: {} };
  }

  private load(): LedgerFile {
    const today = utcDay(this.now());
    if (!this.file) return { day: today, counters: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as LedgerFile;
      if (parsed.day === today && parsed.counters && typeof parsed.counters === 'object') return parsed;
    } catch {
      // no file yet, or unreadable: start the day from zero
    }
    return { day: today, counters: {} };
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}

/**
 * Keys that may be used once, ever (one sponsorship per account), kept in a small JSON file so a
 * restart or a new day does not forget them. It grows only as fast as the daily budget allows.
 */
export class OnceLedger {
  private readonly keys: Set<string>;

  /** `file` null keeps the keys in memory only (tests). */
  constructor(private readonly file: string | null) {
    this.keys = new Set(this.load());
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Marks `key` used; false when it already was. */
  take(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.save();
    return true;
  }

  /** Forgets a key taken for something that did not happen. */
  release(key: string): void {
    if (this.keys.delete(key)) this.save();
  }

  private load(): string[] {
    if (!this.file) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { keys?: unknown };
      return Array.isArray(parsed.keys) ? parsed.keys.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ keys: [...this.keys] }));
    renameSync(tmp, this.file);
  }
}

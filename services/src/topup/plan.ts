/**
 * Top-up planning: what to send where, within the daily cap and what the treasury can spare.
 * Pure, so amounts, the cap and the treasury warning are tested without a network.
 */

import { minBigint } from '../lib/units';
import type { Watch } from './config';

export interface Reading extends Watch {
  /** yoctoNEAR; null when unreadable or (for an account) missing. For storage, null means unregistered. */
  balance: bigint | null;
  error?: string;
}

export interface Refill {
  kind: Watch['kind'];
  account: string;
  contract?: string;
  amount: bigint;
  /** True when the cap or the treasury allowed less than the way to target. */
  partial: boolean;
}

export interface Plan {
  refills: Refill[];
  skipped: Array<{ account: string; kind: Watch['kind']; reason: string }>;
  treasuryLow: boolean;
  capLeft: bigint;
}

export interface PlanInput {
  readings: Reading[];
  treasury: bigint | null;
  dailyUsed: bigint;
  dailyCap: bigint;
  warn: bigint;
  reserve: bigint;
}

export function belowMin(r: Reading): boolean {
  if (r.error) return false;
  if (r.balance === null) return r.kind === 'storage';
  return r.balance < r.min;
}

export function planTopUps(p: PlanInput): Plan {
  let capLeft = p.dailyCap > p.dailyUsed ? p.dailyCap - p.dailyUsed : 0n;
  let spendable = p.treasury !== null && p.treasury > p.reserve ? p.treasury - p.reserve : 0n;
  const plan: Plan = { refills: [], skipped: [], treasuryLow: p.treasury === null || p.treasury < p.warn, capLeft };
  for (const r of p.readings) {
    if (r.error) {
      plan.skipped.push({ account: r.account, kind: r.kind, reason: `balance unreadable: ${r.error}` });
      continue;
    }
    if (r.balance === null && r.kind === 'account') {
      plan.skipped.push({ account: r.account, kind: r.kind, reason: 'account does not exist' });
      continue;
    }
    const balance = r.balance ?? 0n;
    if (balance >= r.min) continue;
    const need = r.target - balance;
    const amount = minBigint(need, minBigint(capLeft, spendable));
    if (amount <= 0n) {
      plan.skipped.push({ account: r.account, kind: r.kind, reason: capLeft <= 0n ? 'daily cap reached' : 'treasury too low' });
      continue;
    }
    plan.refills.push({ kind: r.kind, account: r.account, ...(r.contract ? { contract: r.contract } : {}), amount, partial: amount < need });
    capLeft -= amount;
    spendable -= amount;
  }
  plan.capLeft = capLeft;
  return plan;
}

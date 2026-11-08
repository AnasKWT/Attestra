/**
 * What the relayer accepts. Requests are checked off chain exactly as the contract will check
 * them (shape, deadline, NEP-413 signature for the attestations contract), then against the
 * allowlist and the daily budgets, so the relayer never pays gas for a request it should refuse.
 */

import { base58Decode, bytesToHex, verifyRequest, type DelegatedAction, type SignedRequest, type StorageBalance } from '@attestra/sdk';
import { isValidAccountId } from 'near-kit';
import type { DailyLedger } from '../lib/ledger';
import { parseNear } from '../lib/units';
import type { RelayerConfig } from './config';

/** Below this storage balance (available) the relayer attaches `STORAGE_TOP_UP`. */
export const STORAGE_LOW = parseNear('0.01');
export const STORAGE_TOP_UP = parseNear('0.02');
/** What `/v1/sponsor-storage` deposits. */
export const SPONSOR_AMOUNT = parseNear('0.05');

export type Checked<T> = { ok: true; value: T } | { ok: false; status: 400 | 401 | 403 | 429; error: string };

const fail = (status: 400 | 401 | 403 | 429, error: string): Checked<never> => ({ ok: false, status, error });
const isHex32 = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** Checks a signed request's shape, message, deadline and signature. */
export function checkSignedRequest(input: unknown, recipient: string, nowSecs: number): Checked<{ request: SignedRequest; action: DelegatedAction }> {
  if (!input || typeof input !== 'object') return fail(400, 'body must be { request: SignedRequest }');
  const r = input as Record<string, unknown>;
  for (const k of ['message', 'nonce', 'public_key', 'signature'] as const) {
    if (typeof r[k] !== 'string' || !r[k]) return fail(400, `request.${k} must be a non-empty string`);
  }
  if (r.callback_url !== undefined && r.callback_url !== null && typeof r.callback_url !== 'string') return fail(400, 'request.callback_url must be a string or null');
  const request: SignedRequest = {
    message: r.message as string,
    nonce: r.nonce as string,
    public_key: r.public_key as string,
    signature: r.signature as string,
    callback_url: (r.callback_url as string | null | undefined) ?? null,
  };
  if (!request.public_key.startsWith('ed25519:')) return fail(400, 'only ed25519 keys can sign requests');

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(request.message);
  } catch {
    return fail(400, 'request.message is not JSON');
  }
  if (!msg || typeof msg !== 'object') return fail(400, 'request.message must be a JSON object');
  if (msg.action !== 'attest' && msg.action !== 'revoke') return fail(400, 'action must be attest or revoke');
  if (typeof msg.attester !== 'string' || !isValidAccountId(msg.attester)) return fail(400, 'attester must be a valid account id');
  if (typeof msg.deadline !== 'number' || !Number.isInteger(msg.deadline)) return fail(400, 'deadline must be unix seconds');
  if (msg.deadline < nowSecs) return fail(400, 'the signed request expired (deadline is in the past)');
  if (msg.action === 'attest') {
    if (!isHex32(msg.schema_uid)) return fail(400, 'schema_uid must be 64 lowercase hex characters');
    if (typeof msg.subject !== 'string' || !msg.subject) return fail(400, 'subject must be a non-empty string');
    if (typeof msg.data !== 'string') return fail(400, 'data must be base64');
    if (msg.ref_uid != null && !isHex32(msg.ref_uid)) return fail(400, 'ref_uid must be 64 lowercase hex characters');
    if (msg.expiration_time != null && (typeof msg.expiration_time !== 'number' || msg.expiration_time < 0)) return fail(400, 'expiration_time must be unix seconds');
  } else if (!isHex32(msg.uid)) {
    return fail(400, 'uid must be 64 lowercase hex characters');
  }

  let valid = false;
  try {
    valid = verifyRequest(request, recipient);
  } catch {
    valid = false;
  }
  if (!valid) return fail(401, `invalid signature (the request must be signed for ${recipient})`);
  return { ok: true, value: { request, action: msg as unknown as DelegatedAction } };
}

/** Deposit to attach so the attester's storage balance can pay for the record: 0 or `STORAGE_TOP_UP`. */
export function storageTopUp(balance: StorageBalance | null): bigint {
  if (balance && BigInt(balance.available) >= STORAGE_LOW) return 0n;
  return STORAGE_TOP_UP;
}

export const KEYS = {
  attester: (a: string) => `submit:${a}`,
  submitTotal: 'submit:*',
  storage: 'storage:yocto',
  sender: (s: string) => `meta:${s}`,
  metaTotal: 'meta:*',
  sponsored: (account: string, contract: string) => `sponsor:${contract}:${account}`,
};

/** Allowlist and daily budgets over a persisted ledger. */
export class RelayerPolicy {
  constructor(
    private readonly cfg: Pick<RelayerConfig, 'allowlist' | 'dailyPerAttester' | 'dailyTotal' | 'storageBudget' | 'metaDailyPerSender' | 'metaDailyTotal'>,
    private readonly ledger: DailyLedger,
  ) {}

  allows(attester: string): boolean {
    return this.cfg.allowlist.size === 0 || this.cfg.allowlist.has(attester);
  }

  /** Counts one submission for `attester`; an error message when a budget is spent. */
  takeSubmission(attester: string): string | null {
    const refused = this.ledger.take(
      [
        [KEYS.attester(attester), BigInt(this.cfg.dailyPerAttester)],
        [KEYS.submitTotal, BigInt(this.cfg.dailyTotal)],
      ],
      1n,
    );
    if (!refused) return null;
    return refused === KEYS.submitTotal ? 'the relayer reached its daily submission budget' : `${attester} reached its daily budget of ${this.cfg.dailyPerAttester} submissions`;
  }

  /** Gives back a submission that was refused after it was counted. */
  refundSubmission(attester: string): void {
    this.ledger.refund([KEYS.attester(attester), KEYS.submitTotal], 1n);
  }

  /** Reserves NEAR for storage; false when today's storage budget cannot cover it. */
  takeStorage(amount: bigint): boolean {
    return this.ledger.take([[KEYS.storage, this.cfg.storageBudget]], amount) === null;
  }

  refundStorage(amount: bigint): void {
    this.ledger.refund([KEYS.storage], amount);
  }

  /** One sponsored deposit per account, contract and day. */
  takeSponsor(account: string, contract: string): boolean {
    return this.ledger.take([[KEYS.sponsored(account, contract), 1n]], 1n) === null;
  }

  refundSponsor(account: string, contract: string): void {
    this.ledger.refund([KEYS.sponsored(account, contract)], 1n);
  }

  takeMeta(sender: string): string | null {
    const refused = this.ledger.take(
      [
        [KEYS.sender(sender), BigInt(this.cfg.metaDailyPerSender)],
        [KEYS.metaTotal, BigInt(this.cfg.metaDailyTotal)],
      ],
      1n,
    );
    if (!refused) return null;
    return refused === KEYS.metaTotal ? 'the relayer reached its daily meta-transaction budget' : `${sender} reached its daily budget of ${this.cfg.metaDailyPerSender} meta-transactions`;
  }

  usage() {
    return {
      day: this.ledger.day,
      submissions: { used: Number(this.ledger.used(KEYS.submitTotal)), limit: this.cfg.dailyTotal, per_attester: this.cfg.dailyPerAttester },
      meta: { used: Number(this.ledger.used(KEYS.metaTotal)), limit: this.cfg.metaDailyTotal, per_sender: this.cfg.metaDailyPerSender },
      storage_yocto: { used: this.ledger.used(KEYS.storage).toString(), limit: this.cfg.storageBudget.toString() },
    };
  }
}

/** True when `attester` is the implicit account made of `publicKey` (no registration needed). */
export function isImplicitOf(attester: string, publicKey: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(attester)) return false;
  try {
    return bytesToHex(base58Decode(publicKey.replace(/^ed25519:/, ''))) === attester;
  } catch {
    return false;
  }
}

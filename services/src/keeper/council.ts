/**
 * The keeper as a Sputnik DAO reviewer. Each pass it reads the newest open proposals of the DAOs
 * whose policy lets it vote on function calls, and votes on membership requests by a fixed rule;
 * everything else (other schemas, revocations, transfers, policy changes) is left to the council.
 * On the deployment DAO its role can only vote on function calls (`attestingDaoPolicy` reviewers).
 *
 * The rule: one `attest` call on the attestations contract, under the well-known membership
 * schema, about the proposer, naming this DAO as the organization, in an allowed role, with no
 * deposit. A request that breaks one of these is rejected with the reason as the vote's memo.
 */

import {
  attestraEvents,
  daoCan,
  DAO_MAX_ACTION_GAS,
  errorMessage,
  KNOWN_SCHEMAS,
  knownSchemaUid,
  parseDaoCall,
  receiptFailure,
  SchemaEncoder,
  type DaoPolicy,
  type DaoProposal,
} from 'attestra';
import type { ChainReader, ChainWriter } from '../lib/chain';
import type { Logger, RecentErrors } from '../lib/log';
import { TGAS } from '../lib/units';

export type Decision = 'approve' | 'reject' | 'skip';

export interface CouncilRule {
  dao: string;
  attestations: string;
  /** Roles the keeper approves without a human. */
  roles: string[];
  nowSecs: number;
}

export interface ReviewedProposal {
  dao: string;
  id: number;
  decision: Decision;
  reason: string;
  /** The proposal's status after the vote. */
  status?: string;
  tx?: string;
  attestation?: string;
}

const MEMBERSHIP = knownSchemaUid('membership');
const encoder = new SchemaEncoder(KNOWN_SCHEMAS.membership.definition);
const VOTE_GAS = 300n * TGAS;
/** A clock skew allowance for `since`. */
const SKEW_SECS = 600;
/** Proposals read per DAO per pass. */
const WINDOW = 20;
const MAX_TRIES = 3;
/** The DAO's storage balance on the attestations contract is topped up to cover what it issues. */
const STORAGE_LOW = 5n * 10n ** 22n;
const STORAGE_TOP_UP = 10n ** 23n;

/** What the keeper does with one proposal, and why. */
export function review(p: DaoProposal, rule: CouncilRule): { decision: Decision; reason: string } {
  if (p.status !== 'InProgress') return { decision: 'skip', reason: `already ${p.status}` };
  const call = parseDaoCall(p.kind, rule.attestations);
  if (!call) return { decision: 'skip', reason: 'not a single call to the attestations contract; left to the council' };
  if (call.method !== 'attest') return { decision: 'skip', reason: 'a revocation; left to the council' };
  if (call.schemaUid !== MEMBERSHIP) return { decision: 'skip', reason: 'not the membership schema; left to the council' };
  if (call.deposit !== '0') return { decision: 'reject', reason: 'the call attaches a deposit from the DAO' };
  if (BigInt(call.gas) > DAO_MAX_ACTION_GAS) return { decision: 'reject', reason: 'the call asks for too much gas' };
  if (call.subject !== p.proposer) return { decision: 'reject', reason: `a member can only ask about their own account (${p.proposer})` };
  let fields: Record<string, unknown>;
  try {
    fields = encoder.decode(call.data);
  } catch {
    return { decision: 'reject', reason: 'the data does not decode under the membership schema' };
  }
  if (fields.organization !== rule.dao) return { decision: 'reject', reason: `the organization must be ${rule.dao}` };
  if (!rule.roles.includes(String(fields.role))) return { decision: 'reject', reason: `role "${String(fields.role)}" needs a human vote; automatic roles: ${rule.roles.join(', ')}` };
  if (Number(fields.since) > rule.nowSecs + SKEW_SECS) return { decision: 'reject', reason: '"since" is in the future' };
  if (call.expirationTime !== null && call.expirationTime <= rule.nowSecs) return { decision: 'reject', reason: 'the expiration time has passed' };
  return { decision: 'approve', reason: `membership of ${p.proposer} as ${String(fields.role)} matches the council rule` };
}

export class Council {
  last: { at: string; reviewed: ReviewedProposal[] } | null = null;
  private inFlight: Promise<ReviewedProposal[]> | null = null;
  /** Proposals this keeper voted on or left alone, so a pass does not read them twice. */
  private readonly done = new Set<string>();
  private readonly notMember = new Set<string>();
  /** Failed votes per proposal: a vote that keeps failing is given up after MAX_TRIES. */
  private readonly tries = new Map<string, number>();

  constructor(
    private readonly deps: {
      daos: string[];
      roles: string[];
      attestations: string;
      reader: ChainReader;
      writer: ChainWriter | null;
      log: Logger;
      errors: RecentErrors;
      nowSecs?: () => number;
    },
  ) {}

  /** One review of every DAO; never throws. A call during a review gets that review. */
  run(): Promise<ReviewedProposal[]> {
    this.inFlight ??= this.pass().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async pass(): Promise<ReviewedProposal[]> {
    const out: ReviewedProposal[] = [];
    const writer = this.deps.writer;
    if (!writer) return out;
    for (const dao of this.deps.daos) {
      try {
        out.push(...(await this.reviewDao(dao, writer)));
      } catch (e) {
        const message = `reviewing ${dao}: ${errorMessage(e)}`;
        this.deps.errors.add(message);
        this.deps.log(message);
      }
    }
    this.last = { at: new Date().toISOString(), reviewed: out };
    return out;
  }

  private async reviewDao(dao: string, writer: ChainWriter): Promise<ReviewedProposal[]> {
    const policy = await this.deps.reader.view<DaoPolicy>(dao, 'get_policy');
    if (!daoCan(policy, writer.accountId, 'VoteApprove')) {
      if (!this.notMember.has(dao)) this.deps.log(`${writer.accountId} is not on the council of ${dao}; not reviewing it`);
      this.notMember.add(dao);
      return [];
    }
    this.notMember.delete(dao);
    const last = await this.deps.reader.view<number>(dao, 'get_last_proposal_id');
    const from = Math.max(0, last - WINDOW);
    const proposals = last > from ? await this.deps.reader.view<DaoProposal[]>(dao, 'get_proposals', { from_index: from, limit: last - from }) : [];
    const out: ReviewedProposal[] = [];
    const now = this.deps.nowSecs?.() ?? Math.floor(Date.now() / 1000);
    for (const p of proposals) {
      const key = `${dao}#${p.id}`;
      if (this.done.has(key)) continue;
      if (p.status !== 'InProgress' || p.votes[writer.accountId]) {
        this.done.add(key);
        continue;
      }
      const { decision, reason } = review(p, { dao, attestations: this.deps.attestations, roles: this.deps.roles, nowSecs: now });
      if (decision === 'skip') {
        this.done.add(key);
        out.push({ dao, id: p.id, decision, reason });
        continue;
      }
      try {
        if (decision === 'approve') await this.ensureStorage(dao, writer);
        const r = await writer.call(dao, 'act_proposal', { id: p.id, action: decision === 'approve' ? 'VoteApprove' : 'VoteReject', proposal: p.kind, memo: reason.slice(0, 200) }, { gas: VOTE_GAS });
        this.done.add(key);
        const after = await this.deps.reader.view<DaoProposal>(dao, 'get_proposal', { id: p.id });
        const created = attestraEvents(r.outcome).find((e) => e.event === 'attestation_created' || e.event === 'attestation_pending');
        const uid = created?.data[0]?.uid;
        const item: ReviewedProposal = { dao, id: p.id, decision, reason, status: after.status, tx: r.txHash, ...(typeof uid === 'string' ? { attestation: uid } : {}) };
        if (after.status === 'Failed') {
          item.reason = `${reason}; the DAO's call failed: ${receiptFailure(r.outcome) ?? 'see the transaction'}`;
          this.deps.errors.add(`${dao} proposal ${p.id} failed after approval (tx ${r.txHash})`);
        }
        out.push(item);
        this.deps.log(`${decision} ${dao} proposal ${p.id} (${after.status}) tx ${r.txHash}${item.attestation ? ` attestation ${item.attestation}` : ''}`);
      } catch (e) {
        const msg = errorMessage(e);
        // Another member decided it first, or it expired: nothing left to do.
        if (/ERR_PROPOSAL_NOT_READY_FOR_VOTE|ERR_ALREADY_VOTED|ERR_NO_PROPOSAL/.test(msg)) {
          this.done.add(key);
          continue;
        }
        const tries = (this.tries.get(key) ?? 0) + 1;
        this.tries.set(key, tries);
        if (tries >= MAX_TRIES) this.done.add(key);
        this.deps.errors.add(`voting on ${dao} proposal ${p.id} (try ${tries} of ${MAX_TRIES}): ${msg}`);
        this.deps.log(`voting on ${dao} proposal ${p.id} (try ${tries} of ${MAX_TRIES}): ${msg}`);
        out.push({ dao, id: p.id, decision, reason: `vote failed: ${msg}` });
      }
    }
    if (this.done.size > 10_000) this.done.clear();
    return out;
  }

  /** Tops up the DAO's storage balance on the attestations contract before it issues. */
  private async ensureStorage(dao: string, writer: ChainWriter): Promise<void> {
    const b = await this.deps.reader.view<{ available: string } | null>(this.deps.attestations, 'storage_balance_of', { account_id: dao });
    if (b && BigInt(b.available) >= STORAGE_LOW) return;
    const r = await writer.call(this.deps.attestations, 'storage_deposit', { account_id: dao }, { deposit: STORAGE_TOP_UP, gas: 30n * TGAS });
    this.deps.log(`storage for ${dao} topped up, tx ${r.txHash}`);
  }
}

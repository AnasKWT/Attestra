/**
 * The keeper as a Sputnik DAO's membership desk. The DAO's council votes once to make the keeper
 * an Attestra delegate of the DAO (`add_delegate`, proposed with `daoDelegateProposal`), scoped
 * on chain to the membership schema, a use limit and an expiry. The keeper then issues membership
 * attestations with `attest_on_behalf`, so the attester is the DAO, and the attestations contract
 * enforces the scope: the keeper's key cannot vote, move the DAO's funds, change its policy or
 * attest anything else, and the council revokes the grant with one more proposal.
 *
 * A request is the account's own NEP-413 signature over `daoMembershipMessage` (the account asks
 * for itself, with a full-access key). It is granted when:
 *   - the role is one of the automatic roles (others go to the council as a proposal),
 *   - the account holds no active membership from this DAO yet,
 *   - another issuer already vouches for the account: at least one active attestation about it
 *     from an attester that is neither the account nor the DAO (a passed private check, a linked
 *     wallet, a member's vouch). That is the DAO's reputation-based access rule.
 */

import {
  attestraEvents,
  errorMessage,
  KNOWN_SCHEMAS,
  knownSchemaUid,
  SchemaEncoder,
  verifyDaoMembershipRequest,
  type DaoMembershipRequest,
  type IndexedAttestation,
  type Paginated,
} from 'attestra';
import type { ChainReader, ChainWriter } from '../lib/chain';
import type { Logger } from '../lib/log';
import { TGAS } from '../lib/units';

export interface MembershipIndexer {
  listAttestations(q: { schema?: string; attester?: string; subject?: string; status?: string; limit?: number }): Promise<Paginated<IndexedAttestation>>;
}

export interface MembershipResult {
  dao: string;
  account: string;
  role: string;
  attestation: string;
  tx: string;
}

const MEMBERSHIP = knownSchemaUid('membership');
const encoder = new SchemaEncoder(KNOWN_SCHEMAS.membership.definition);
const ISSUE_GAS = 100n * TGAS;
/** A membership the desk issues lasts a year; the member asks again after that. */
const MEMBERSHIP_SECS = 365 * 86_400;
/** The DAO's storage balance on the attestations contract is topped up to cover what it issues. */
const STORAGE_LOW = 5n * 10n ** 22n;
const STORAGE_TOP_UP = 10n ** 23n;

/** A refusal the caller can act on (HTTP 4xx), as opposed to an outage. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 = 403,
  ) {
    super(message);
  }
}

export class MembershipDesk {
  private inFlight = new Set<string>();
  /** Memberships issued lately, until the indexer has them (it trails the chain by seconds to minutes). */
  private readonly issued = new Map<string, { uid: string; at: number }>();

  constructor(
    private readonly deps: {
      daos: string[];
      roles: string[];
      attestations: string;
      reader: ChainReader;
      writer: ChainWriter | null;
      indexer: MembershipIndexer;
      log: Logger;
      hasFullAccessKey: (accountId: string, publicKey: string) => Promise<boolean>;
      nowSecs?: () => number;
    },
  ) {}

  private now() {
    return this.deps.nowSecs?.() ?? Math.floor(Date.now() / 1000);
  }

  /** What a client needs to know before asking. */
  info() {
    return { daos: this.deps.daos, auto_roles: this.deps.roles, delegate: this.deps.writer?.accountId ?? null, schema: MEMBERSHIP };
  }

  /** Checks a signed request against the rules and issues the membership as the DAO. */
  async request(req: DaoMembershipRequest): Promise<MembershipResult> {
    const writer = this.deps.writer;
    if (!writer) throw new Error('the keeper is read-only');
    let m: { dao: string; account: string; role: string };
    try {
      m = await verifyDaoMembershipRequest(req, { attestations: this.deps.attestations, hasFullAccessKey: this.deps.hasFullAccessKey, now: this.now() });
    } catch (e) {
      throw new Refusal(errorMessage(e), 403);
    }
    if (!this.deps.daos.includes(m.dao)) throw new Refusal(`${m.dao} is not a DAO this keeper issues for`, 400);
    if (!this.deps.roles.includes(m.role)) throw new Refusal(`role "${m.role}" needs a council vote; automatic roles: ${this.deps.roles.join(', ')}`, 400);
    const key = `${m.dao}#${m.account}`;
    if (this.inFlight.has(key)) throw new Refusal(`a request of ${m.account} is already being issued`, 409);
    this.inFlight.add(key);
    try {
      const grant = await this.deps.reader.view<Record<string, unknown> | null>(this.deps.attestations, 'get_delegate', { authority: m.dao, delegate: writer.accountId });
      if (!grant) throw new Error(`${writer.accountId} is not a delegate of ${m.dao}: the council has to grant it first`);

      for (const [k, v] of this.issued) if (this.now() - v.at > 3600) this.issued.delete(k);
      const recent = this.issued.get(key);
      if (recent) throw new Refusal(`${m.account} is already a member of ${m.dao} (${recent.uid})`, 409);
      const held = await this.deps.indexer.listAttestations({ attester: m.dao, subject: m.account, schema: MEMBERSHIP, status: 'active', limit: 1 });
      if (held.data.length) throw new Refusal(`${m.account} is already a member of ${m.dao} (${held.data[0].uid})`, 409);
      const about = await this.deps.indexer.listAttestations({ subject: m.account, status: 'active', limit: 50 });
      if (!about.data.some((a) => a.attester !== m.account && a.attester !== m.dao)) {
        throw new Refusal(`no other issuer vouches for ${m.account} yet: get one attestation about your account first (a private check, a linked wallet or a member's vouch)`, 403);
      }

      await this.ensureStorage(m.dao, writer);
      const now = this.now();
      const data = encoder.encode({ organization: m.dao, role: m.role, since: now });
      const r = await writer.call(
        this.deps.attestations,
        'attest_on_behalf',
        { authority: m.dao, schema_uid: MEMBERSHIP, subject: m.account, data, expiration_time: now + MEMBERSHIP_SECS, ref_uid: null },
        { gas: ISSUE_GAS },
      );
      const created = attestraEvents(r.outcome).find((e) => e.event === 'attestation_created' || e.event === 'attestation_pending');
      const uid = (created?.data[0]?.uid as string | undefined) ?? (r.value as { uid?: string } | null)?.uid;
      if (!uid) throw new Error(`the attestation was not created (tx ${r.txHash})`);
      this.issued.set(key, { uid, at: this.now() });
      this.deps.log(`membership of ${m.account} as ${m.role} issued by ${m.dao}: ${uid} tx ${r.txHash}`);
      return { dao: m.dao, account: m.account, role: m.role, attestation: uid, tx: r.txHash };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Tops up the DAO's storage balance on the attestations contract before it issues. */
  private async ensureStorage(dao: string, writer: ChainWriter): Promise<void> {
    const b = await this.deps.reader.view<{ available: string } | null>(this.deps.attestations, 'storage_balance_of', { account_id: dao });
    if (b && BigInt(b.available) >= STORAGE_LOW) return;
    const r = await writer.call(this.deps.attestations, 'storage_deposit', { account_id: dao }, { deposit: STORAGE_TOP_UP, gas: 30n * TGAS });
    this.deps.log(`storage for ${dao} topped up, tx ${r.txHash}`);
  }
}

import { attestingDaoPolicy, daoAttestProposal, daoRevokeProposal, KNOWN_SCHEMAS, knownSchemaUid, SchemaEncoder, type DaoPolicy, type DaoProposal } from '@attestra/sdk';
import { describe, expect, it } from 'vitest';
import { createKeeperApp } from '../src/keeper/app';
import { loadKeeperConfig } from '../src/keeper/config';
import { Council, review } from '../src/keeper/council';
import { Keeper } from '../src/keeper/keeper';
import type { ChainReader } from '../src/lib/chain';
import { RecentErrors } from '../src/lib/log';
import { FakeIndexer, FakeWriter, quietLog } from './fakes';

const NOW = 1_800_000_000;
const DAO = 'guild.sputnik-v2.testnet';
const A = 'attestations.attestra.testnet';
const KEEPER = 'keeper.attestra.testnet';
const enc = new SchemaEncoder(KNOWN_SCHEMAS.membership.definition);
const rule = { dao: DAO, attestations: A, roles: ['member', 'contributor'], nowSecs: NOW };

function proposal(id: number, over: { proposer?: string; subject?: string; organization?: string; role?: string; since?: number; schemaUid?: string; status?: DaoProposal['status']; kind?: DaoProposal['kind'] } = {}): DaoProposal {
  const proposer = over.proposer ?? 'alice.testnet';
  const data = enc.encode({ organization: over.organization ?? DAO, role: over.role ?? 'member', since: over.since ?? NOW - 60 });
  const kind = over.kind ?? daoAttestProposal(A, { schemaUid: over.schemaUid ?? knownSchemaUid('membership'), subject: over.subject ?? proposer, data }).kind;
  return { id, proposer, description: 'membership', kind, status: over.status ?? 'InProgress', vote_counts: {}, votes: {}, submission_time: '0' };
}

describe('council rule', () => {
  it('approves a well-formed membership request about the proposer', () => {
    expect(review(proposal(0), rule).decision).toBe('approve');
    expect(review(proposal(0, { role: 'contributor' }), rule).decision).toBe('approve');
  });

  it('rejects requests that break the rule, with the reason', () => {
    expect(review(proposal(0, { subject: 'bob.testnet' }), rule)).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/own account/) });
    expect(review(proposal(0, { organization: 'other.sputnik-v2.testnet' }), rule)).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/organization/) });
    expect(review(proposal(0, { role: 'admin' }), rule)).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/human vote/) });
    expect(review(proposal(0, { since: NOW + 3600 }), rule)).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/future/) });
    const deposit = proposal(0);
    (deposit.kind as { FunctionCall: { actions: Array<{ deposit: string }> } }).FunctionCall.actions[0].deposit = '1';
    expect(review(deposit, rule).decision).toBe('reject');
  });

  it('leaves everything else to the human council', () => {
    expect(review(proposal(0, { schemaUid: 'ab'.repeat(32) }), rule)).toMatchObject({ decision: 'skip', reason: expect.stringMatching(/membership schema/) });
    expect(review(proposal(0, { kind: daoRevokeProposal(A, 'cd'.repeat(32)).kind }), rule)).toMatchObject({ decision: 'skip', reason: expect.stringMatching(/revocation/) });
    expect(review(proposal(0, { kind: { Transfer: { token_id: '', receiver_id: 'x.testnet', amount: '1' } } }), rule).decision).toBe('skip');
    expect(review(proposal(0, { kind: daoAttestProposal('evil.testnet', { schemaUid: knownSchemaUid('membership'), subject: 'alice.testnet', data: enc.encode({ organization: DAO, role: 'member', since: NOW }) }).kind }), rule).decision).toBe('skip');
    expect(review(proposal(0, { status: 'Approved' }), rule).decision).toBe('skip');
  });
});

/** A DAO and the attestations contract as views. */
function chain(policy: DaoPolicy, proposals: DaoProposal[], storage = '0'): ChainReader & { proposals: DaoProposal[] } {
  return {
    proposals,
    view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      if (contract === A && method === 'storage_balance_of') return Promise.resolve({ total: storage, available: storage } as T);
      if (contract !== DAO) return Promise.reject(new Error(`unexpected view ${contract}.${method}`));
      if (method === 'get_policy') return Promise.resolve(policy as T);
      if (method === 'get_last_proposal_id') return Promise.resolve(proposals.length as T);
      if (method === 'get_proposals') return Promise.resolve(proposals.slice(Number(args.from_index), Number(args.from_index) + Number(args.limit)) as T);
      if (method === 'get_proposal') return Promise.resolve(proposals[Number(args.id)] as T);
      return Promise.reject(new Error(`unexpected view ${method}`));
    },
    balance: () => Promise.resolve(10n ** 24n),
    hasKey: () => Promise.resolve(false),
  };
}

describe('council member', () => {
  const created = (uid: string) => ({ receipts_outcome: [{ outcome: { logs: [`EVENT_JSON:${JSON.stringify({ standard: 'attestra', version: '1.0.0', event: 'attestation_created', data: [{ uid }] })}`] } }] });

  it('votes once per open proposal, tops up the DAO storage first, and reports the attestation', async () => {
    const reader = chain(attestingDaoPolicy([KEEPER, 'attestra.testnet']), [proposal(0), proposal(1, { subject: 'bob.testnet' }), proposal(2, { role: 'admin' }), proposal(3, { status: 'Approved' })]);
    const writer = new FakeWriter(KEEPER);
    const outcomes: Record<number, unknown> = {};
    writer.respond = (tx) => {
      if (tx.method === 'act_proposal') {
        const p = reader.proposals[Number(tx.args!.id)];
        p.status = tx.args!.action === 'VoteApprove' ? 'Approved' : 'Rejected';
        if (p.status === 'Approved') outcomes[p.id] = created('ee'.repeat(32));
      }
      return null;
    };
    // The fake writer has no outcome; hand the vote its receipts like the real one.
    const call = writer.call.bind(writer);
    writer.call = async (c, m, a, o) => ({ ...(await call(c, m, a, o)), outcome: outcomes[Number((a as { id?: number }).id)] });
    const council = new Council({ daos: [DAO], roles: ['member'], attestations: A, reader, writer, log: quietLog(), errors: new RecentErrors(), nowSecs: () => NOW });
    const out = await council.run();
    expect(writer.sent.map((t) => `${t.receiver}.${t.method}`)).toEqual([`${A}.storage_deposit`, `${DAO}.act_proposal`, `${DAO}.act_proposal`, `${DAO}.act_proposal`]);
    expect(writer.sent[0].args).toEqual({ account_id: DAO });
    expect(writer.sent[1].args).toMatchObject({ id: 0, action: 'VoteApprove', proposal: reader.proposals[0].kind });
    expect(writer.sent[2].args).toMatchObject({ id: 1, action: 'VoteReject' });
    expect(out.find((r) => r.id === 0)).toMatchObject({ decision: 'approve', status: 'Approved', attestation: 'ee'.repeat(32) });
    expect(out.find((r) => r.id === 2)).toMatchObject({ decision: 'reject', status: 'Rejected' });
    expect(out.some((r) => r.id === 3)).toBe(false);
    // A second pass reads the same proposals and sends nothing.
    await council.run();
    expect(writer.sent.length).toBe(4);
  });

  it('does not vote on a DAO whose council it is not on, and gives up a failing vote after three tries', async () => {
    const outsider = new FakeWriter('someone.testnet');
    const notMember = new Council({ daos: [DAO], roles: ['member'], attestations: A, reader: chain(attestingDaoPolicy([KEEPER]), [proposal(0)]), writer: outsider, log: quietLog(), errors: new RecentErrors(), nowSecs: () => NOW });
    expect(await notMember.run()).toEqual([]);
    expect(outsider.sent).toEqual([]);

    const writer = new FakeWriter(KEEPER);
    writer.respond = (tx) => {
      if (tx.method === 'act_proposal') throw new Error('Exceeded the prepaid gas');
      return null;
    };
    const errors = new RecentErrors();
    const council = new Council({ daos: [DAO], roles: ['member'], attestations: A, reader: chain(attestingDaoPolicy([KEEPER]), [proposal(0)], '1000000000000000000000000'), writer, log: quietLog(), errors, nowSecs: () => NOW });
    for (let i = 0; i < 5; i++) await council.run();
    expect(writer.sent.filter((t) => t.method === 'act_proposal').length).toBe(3);
    expect(errors.list().some((e) => /try 3 of 3/.test(e.message))).toBe(true);
  });

  it('is reachable over HTTP and on by default only for the deployment DAO', async () => {
    expect(loadKeeperConfig({}).daos).toEqual(['attestra.sputnik-v2.testnet']);
    expect(loadKeeperConfig({ KEEPER_DAOS: '' }).daos).toEqual(['attestra.sputnik-v2.testnet']);
    expect(loadKeeperConfig({ KEEPER_DAOS: 'none' }).daos).toEqual([]);
    expect(loadKeeperConfig({ ATTESTRA_ROOT: 'other.testnet' }).daos).toEqual([]);
    expect(loadKeeperConfig({ NEAR_NETWORK: 'mainnet' }).daos).toEqual([]);
    expect(loadKeeperConfig({ KEEPER_DAOS: `${DAO}, x.sputnik-v2.testnet`, KEEPER_DAO_ROLES: 'member' })).toMatchObject({ daos: [DAO, 'x.sputnik-v2.testnet'], daoRoles: ['member'] });

    const config = { ...loadKeeperConfig({ KEEPER_DAOS: DAO }), intervalMs: 60_000 };
    const reader = chain(attestingDaoPolicy([KEEPER]), [proposal(0)], '1000000000000000000000000');
    const writer = new FakeWriter(KEEPER);
    writer.respond = () => null;
    const errors = new RecentErrors();
    const council = new Council({ daos: [DAO], roles: ['member'], attestations: A, reader, writer, log: quietLog(), errors, nowSecs: () => NOW });
    const keeper = new Keeper({ config, indexer: new FakeIndexer(), reader, writer, log: quietLog(), errors });
    const app = createKeeperApp({ config, keeper, council, reader, writer, errors });
    const res = await app.request('/v1/dao/review', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reviewed: Array<{ id: number; decision: string }> }).reviewed).toMatchObject([{ id: 0, decision: 'approve' }]);
    const idle = createKeeperApp({ config, keeper, council, reader, writer: null, errors });
    expect((await idle.request('/v1/dao/review', { method: 'POST' })).status).toBe(503);
  });
});

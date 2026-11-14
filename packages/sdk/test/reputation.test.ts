import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AttestraClient } from '../src/client';
import { SchemaEncoder } from '../src/encoder';
import {
  MemoryTxCache,
  agentTrust,
  assessReputation,
  evaluateReputation,
  inAccountTree,
  isSubAccount,
  isTxHash,
  judgeIdentity,
  judgePayment,
  lookupFromTx,
  paymentQueries,
  recentPayments,
  rpcTxLookup,
  txPayments,
  type AttestationLike,
  type RpcTxResult,
  type TxLookup,
} from '../src/reputation';
import { KNOWN_SCHEMAS } from '../src/schemas';

/** `tx` RPC results recorded on testnet (see the fixture's note). */
const fx = JSON.parse(readFileSync(new URL('./fixtures/payments.json', import.meta.url), 'utf8')) as Record<'x402_settlement' | 'ft_transfer_call' | 'near_transfer', RpcTxResult>;
const X402 = 'Cym3k2orMnXobF7zPwVUXACoFtQVdMkSFvNS7n2XxcYP';
const FT_CALL = '2mb2KTtgAnfQghErTVU39v5PCgzAegnqsH3Ux5mvKbGx';
const TRANSFER = '5D4ZPgvegeQNYPoxo4zJHZDifpskKp9jaMpWEa2Nduhc';
const ROOT = 'attestra.testnet';
const AGENT = 'agent.attestra.testnet';
const TOKEN = 'token.attestra.testnet';
const STAKER = '3b114b03396a55f07b8a17cd43a6e72cd89a11235f8197e8b64b0c01f4aba05c';
const FUNDED = '95319cba6add369b53fd356b623be90598da31753e9cde2ac3c08f054c32b4ff';
const ACCEPTED = { acceptedAssets: ['NEAR', TOKEN] };

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A direct `ft_transfer` signed by the payer, built from the x402 settlement's inner call and token receipt. */
function directFtTransfer(): RpcTxResult {
  const r = clone(fx.x402_settlement);
  const delegate = (r.transaction.actions[0] as { Delegate: { delegate_action: { actions: unknown[] } } }).Delegate.delegate_action;
  return {
    ...r,
    transaction: { ...r.transaction, hash: 'G1rT7Tq1Yq9w4jXxQ8Lz1mE3x4Gm6V3w5n2b8c9d1e2f', signer_id: ROOT, receiver_id: TOKEN, actions: delegate.actions },
    receipts_outcome: r.receipts_outcome.filter((o) => o.outcome.executor_id === TOKEN),
  };
}

let n = 0;
function att(attester: string, subject: string, schema: 'agentIdentity' | 'agentReview', fields: Record<string, unknown>, extra: Partial<AttestationLike> = {}): AttestationLike {
  n++;
  return { uid: n.toString(16).padStart(64, '0'), attester, subject, data: new SchemaEncoder(KNOWN_SCHEMAS[schema].definition).encode(fields), status: 'active', created_at: 1_700_000_000 + n, ...extra };
}
const identity = (attester: string, agent: string, owner = attester, extra: Partial<AttestationLike> = {}) =>
  att(attester, agent, 'agentIdentity', { name: 'Bot', owner, model: 'm', capabilities: ['verify'], endpoint: '', description: '' }, extra);
const review = (attester: string, agent: string, score: number, jobRef = '', extra: Partial<AttestationLike> = {}) => att(attester, agent, 'agentReview', { score, comment: '', job_ref: jobRef }, extra);
const found = (r: RpcTxResult): TxLookup => lookupFromTx(r);

describe('accounts', () => {
  it('knows sub-accounts and account trees', () => {
    expect(isSubAccount('bot.alice.testnet', 'alice.testnet')).toBe(true);
    expect(isSubAccount('x.bot.alice.testnet', 'alice.testnet')).toBe(true);
    expect(isSubAccount('alice.testnet', 'alice.testnet')).toBe(false);
    expect(isSubAccount('malice.testnet', 'alice.testnet')).toBe(false);
    expect(isSubAccount('bot.alice.testnet', '')).toBe(false);
    expect(inAccountTree('alice.testnet', 'alice.testnet')).toBe(true);
    expect(inAccountTree('a.alice.testnet', 'alice.testnet')).toBe(true);
    expect(inAccountTree('bob.testnet', 'alice.testnet')).toBe(false);
  });
});

describe('identity', () => {
  it('verifies a self-registered identity', () => {
    expect(judgeIdentity('bot.testnet', identity('bot.testnet', 'bot.testnet'))).toMatchObject({ status: 'verified', owner: 'bot.testnet', reason: null });
  });

  it('verifies an identity registered by the parent account', () => {
    expect(judgeIdentity('bot.alice.testnet', identity('alice.testnet', 'bot.alice.testnet'))).toMatchObject({ status: 'verified', owner: 'alice.testnet' });
    expect(judgeIdentity(AGENT, identity(ROOT, AGENT)).status).toBe('verified');
  });

  it('leaves an identity by a stranger unverified, with a reason', () => {
    const v = judgeIdentity('bot.testnet', identity('mallory.testnet', 'bot.testnet'));
    expect(v.status).toBe('unverified');
    expect(v.reason).toMatch(/mallory\.testnet is neither bot\.testnet nor an account it is a sub-account of/);
  });

  it('leaves an identity unverified when its owner field is not its attester', () => {
    expect(judgeIdentity('bot.alice.testnet', identity('alice.testnet', 'bot.alice.testnet', 'carol.testnet')).reason).toMatch(/names carol\.testnet as owner, but alice\.testnet attested it/);
    // A sub-account cannot register its parent.
    expect(judgeIdentity('alice.testnet', identity('bot.alice.testnet', 'alice.testnet')).status).toBe('unverified');
  });

  it('prefers the newest verified identity, and otherwise reports the newest one as unverified', () => {
    const own = identity('alice.testnet', 'bot.alice.testnet');
    const stranger = identity('mallory.testnet', 'bot.alice.testnet');
    expect(evaluateReputation({ agent: 'bot.alice.testnet', identities: [stranger, own], reviews: [] })).toMatchObject({ identity: own, identity_status: 'verified', identity_reason: null });
    const only = evaluateReputation({ agent: 'bot.alice.testnet', identities: [stranger], reviews: [] });
    expect(only).toMatchObject({ identity: stranger, identity_status: 'unverified', trusted: false });
    expect(only.trust_reasons[0]).toMatch(/^the identity is unverified: mallory\.testnet/);
    const revoked = evaluateReputation({ agent: 'bot.alice.testnet', identities: [{ ...own, status: 'revoked' }], reviews: [] });
    expect(revoked).toMatchObject({ identity: null, identity_status: 'none' });
    expect(revoked.trust_reasons[0]).toBe('no identity attestation about the agent');
  });
});

describe('payments in a transaction', () => {
  it('reads a NEAR transfer', () => {
    expect(txPayments(fx.near_transfer)).toEqual([{ payer: ROOT, payee: FUNDED, asset: 'NEAR', amount: '1000000000000000000000000', method: 'transfer', relayer: null }]);
  });

  it('reads an ft_transfer_call by the net amount the token moved', () => {
    expect(txPayments(fx.ft_transfer_call)).toEqual([{ payer: STAKER, payee: 'staking.attestra.testnet', asset: TOKEN, amount: '100000000000000000000', method: 'ft_transfer_call', relayer: null }]);
  });

  it('reads an x402 settlement: the agent relayed the payer signed delegate ft_transfer', () => {
    expect(txPayments(fx.x402_settlement)).toEqual([{ payer: ROOT, payee: AGENT, asset: TOKEN, amount: '1000000000000000000', method: 'ft_transfer', relayer: AGENT }]);
  });

  it('reads a direct ft_transfer', () => {
    expect(txPayments(directFtTransfer())).toEqual([{ payer: ROOT, payee: AGENT, asset: TOKEN, amount: '1000000000000000000', method: 'ft_transfer', relayer: null }]);
  });

  it('counts nothing when a NEAR transfer failed or a token call moved nothing', () => {
    const failed = clone(fx.near_transfer);
    failed.receipts_outcome[0].outcome.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: FUNDED } } } } };
    expect(txPayments(failed)).toEqual([]);
    const refunded = clone(fx.ft_transfer_call);
    // The receiver refunded everything: the token logs the transfer back.
    const resolve = refunded.receipts_outcome.find((o, i) => i > 0 && o.outcome.executor_id === TOKEN)!;
    resolve.outcome.logs = [`EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{ old_owner_id: 'staking.attestra.testnet', new_owner_id: STAKER, amount: '100000000000000000000' }] })}`];
    expect(txPayments(refunded)).toEqual([]);
    // Events from a contract other than the token prove nothing.
    const forged = clone(fx.x402_settlement);
    for (const o of forged.receipts_outcome) if (o.outcome.executor_id === TOKEN) o.outcome.executor_id = 'fake-token.testnet';
    expect(txPayments(forged)).toEqual([]);
  });
});

describe('judging a job_ref', () => {
  const payees = [AGENT, ROOT];
  it('accepts a real payment from the reviewer to the agent', () => {
    expect(judgePayment(X402, ROOT, payees, found(fx.x402_settlement), ACCEPTED)).toMatchObject({ paid: true, payment: { payer: ROOT, payee: AGENT, relayer: AGENT } });
    expect(judgePayment(` ${X402} `, ROOT, payees, found(fx.x402_settlement)).paid).toBe(true);
  });

  it('refuses forged job_refs', () => {
    expect(judgePayment('', ROOT, payees, undefined).reason).toBe('no job_ref');
    expect(judgePayment('paid 5 USDC, trust me', ROOT, payees, undefined).reason).toBe('job_ref is not a NEAR transaction hash');
    expect(judgePayment(X402, ROOT, payees, null).reason).toMatch(/could not be checked/);
    expect(judgePayment(X402, ROOT, payees, { found: false, final: false, payments: [] }).reason).toBe('no transaction with this hash on chain');
    expect(judgePayment(X402, ROOT, payees, { ...found(fx.x402_settlement), final: false }).reason).toMatch(/not final/);
    // Someone else's payment.
    expect(judgePayment(X402, 'bob.testnet', payees, found(fx.x402_settlement)).reason).toBe('the transaction is not a payment signed by the reviewer');
    // A payment to another account.
    expect(judgePayment(X402, ROOT, ['other.testnet'], found(fx.x402_settlement)).reason).toBe('the transaction pays another account, not the agent');
    // A token outside the accepted assets.
    expect(judgePayment(X402, ROOT, payees, found(fx.x402_settlement), { acceptedAssets: ['NEAR'] }).reason).toMatch(/is in token\.attestra\.testnet, which is not an accepted/);
  });

  it('knows a transaction hash', () => {
    expect(isTxHash(X402)).toBe(true);
    expect(isTxHash(X402.slice(0, -1) + '0')).toBe(false);
    expect(isTxHash('job-1')).toBe(false);
  });
});

describe('reviews that count', () => {
  const agent = 'bot.alice.testnet';
  const ownId = identity('alice.testnet', agent);

  it('excludes the agent reviewing itself', () => {
    const r = evaluateReputation({ agent, identities: [ownId], reviews: [review(agent, agent, 5)] });
    expect(r).toMatchObject({ review_count: 0, average_score: null, excluded_review_count: 1, excluded_reasons: { self_review: 1 } });
  });

  it('excludes the owner reviewing its agent', () => {
    expect(evaluateReputation({ agent, identities: [ownId], reviews: [review('alice.testnet', agent, 5)] }).excluded_reasons).toEqual({ owner: 1 });
  });

  it('excludes sybil sub-accounts of the owner and of the agent, and accounts above the agent', () => {
    const r = evaluateReputation({
      agent,
      identities: [ownId],
      reviews: [review('fan1.alice.testnet', agent, 5), review('x.bot.alice.testnet', agent, 5), review('testnet', agent, 5), review('bob.testnet', agent, 2)],
    });
    expect(r.excluded_reasons).toEqual({ owner_account: 1, agent_account: 1, agent_parent: 1 });
    expect(r).toMatchObject({ review_count: 1, average_score: 2 });
    expect(r.reviews.map((x) => x.excluded_reason)).toEqual(['owner_account', 'agent_account', 'agent_parent', null]);
  });

  it('excludes the claimed owner and the attester of an unverified identity', () => {
    const stranger = identity('mallory.testnet', 'bot.testnet', 'mallory.testnet');
    const r = evaluateReputation({ agent: 'bot.testnet', identities: [stranger], reviews: [review('mallory.testnet', 'bot.testnet', 5), review('m2.mallory.testnet', 'bot.testnet', 5)] });
    expect(r.excluded_reasons).toEqual({ owner: 1, owner_account: 1 });
  });

  it('counts one review per reviewer: their newest active one', () => {
    const old = review('bob.testnet', agent, 1);
    const newer = review('bob.testnet', agent, 5);
    const revokedNewest = review('bob.testnet', agent, 3, '', { status: 'revoked' });
    const r = evaluateReputation({ agent, identities: [ownId], reviews: [revokedNewest, newer, old] });
    expect(r.reviews.map((x) => [x.counted, x.excluded_reason])).toEqual([[false, 'inactive'], [true, null], [false, 'duplicate_reviewer']]);
    expect(r).toMatchObject({ review_count: 1, average_score: 5, excluded_review_count: 2 });
  });

  it('excludes reviews whose data is not a 1 to 5 score', () => {
    const bad = { ...review('bob.testnet', agent, 5), data: 'AAAA' };
    expect(evaluateReputation({ agent, identities: [ownId], reviews: [bad, review('carol.testnet', agent, 0)] }).excluded_reasons).toEqual({ invalid: 2 });
  });
});

describe('paid reviews and trust', () => {
  it('marks a review paid by a recorded x402 settlement and trusts the agent', () => {
    // agent.attestra.testnet registered itself, so attestra.testnet (its parent) is excluded; a stranger paid instead.
    const self = identity(AGENT, AGENT);
    const r = evaluateReputation(
      { agent: AGENT, identities: [self], reviews: [review(ROOT, AGENT, 5, X402)] },
      ACCEPTED,
    );
    expect(r.reviews[0].excluded_reason).toBe('agent_parent');

    // The same settlement, paid by an account outside the agent's family.
    const settlement = clone(fx.x402_settlement);
    const d = (settlement.transaction.actions[0] as { Delegate: { delegate_action: { sender_id: string } } }).Delegate.delegate_action;
    d.sender_id = 'client.testnet';
    for (const o of settlement.receipts_outcome) o.outcome.logs = o.outcome.logs.map((l) => l.replace(`"old_owner_id":"${ROOT}"`, '"old_owner_id":"client.testnet"'));
    const paid = evaluateReputation({ agent: AGENT, identities: [self], reviews: [review('client.testnet', AGENT, 4, X402), review('bob.testnet', AGENT, 1, 'job-7')], lookups: { [X402]: found(settlement) } }, ACCEPTED);
    expect(paid).toMatchObject({ identity_status: 'verified', review_count: 2, average_score: 2.5, paid_review_count: 1, paid_average_score: 4, trusted: true, trust_reasons: [] });
    expect(paid.reviews[0]).toMatchObject({ paid: true, payment: { payer: 'client.testnet', payee: AGENT, method: 'ft_transfer', relayer: AGENT } });
    expect(paid.reviews[1]).toMatchObject({ paid: false, payment_reason: 'job_ref is not a NEAR transaction hash' });
  });

  it('marks reviews paid by a NEAR transfer and by ft_transfer_call to the agent', () => {
    const near = evaluateReputation({ agent: FUNDED, identities: [identity(FUNDED, FUNDED)], reviews: [review(ROOT, FUNDED, 4, TRANSFER)], lookups: { [TRANSFER]: found(fx.near_transfer) } }, ACCEPTED);
    expect(near).toMatchObject({ paid_review_count: 1, trusted: true });
    expect(near.reviews[0].payment).toMatchObject({ asset: 'NEAR', method: 'transfer' });
    const staking = 'staking.attestra.testnet';
    const ft = evaluateReputation({ agent: staking, identities: [identity(staking, staking)], reviews: [review(STAKER, staking, 5, FT_CALL)], lookups: { [FT_CALL]: found(fx.ft_transfer_call) } }, ACCEPTED);
    expect(ft).toMatchObject({ paid_review_count: 1, paid_average_score: 5, trusted: true });
  });

  it('a payment to the verified owner counts too', () => {
    // bot.attestra.testnet is registered by attestra.testnet; a payment to the owner is a payment for the agent.
    const bot = 'bot.attestra.testnet';
    const settlement = clone(fx.near_transfer);
    settlement.transaction.signer_id = 'client.testnet';
    settlement.transaction.receiver_id = ROOT;
    const r = evaluateReputation({ agent: bot, identities: [identity(ROOT, bot)], reviews: [review('client.testnet', bot, 5, TRANSFER)], lookups: { [TRANSFER]: found(settlement) } });
    expect(r.reviews[0]).toMatchObject({ paid: true, payment: { payee: ROOT } });
  });

  it('gives the reasons an agent is not trusted', () => {
    expect(agentTrust({ identity_status: 'verified', identity_reason: null, paid_review_count: 0, paid_average_score: null }).trust_reasons).toEqual([expect.stringMatching(/^no paid review/)]);
    expect(agentTrust({ identity_status: 'verified', identity_reason: null, paid_review_count: 2, paid_average_score: 3.4 }).trust_reasons).toEqual(['the paid reviews average 3.4, below 3.5']);
    expect(agentTrust({ identity_status: 'verified', identity_reason: null, paid_review_count: 1, paid_average_score: 3.5 })).toEqual({ trusted: true, trust_reasons: [] });
    expect(agentTrust({ identity_status: 'none', identity_reason: null, paid_review_count: 1, paid_average_score: 5 }).trusted).toBe(false);
  });

  it('the live example: an identity and a review by the same stranger account', () => {
    // agent-mwfan23a.testnet on testnet: its identity and its 4-star review came from one implicit account.
    const agent = 'agent-mwfan23a.testnet';
    const r = evaluateReputation({ agent, identities: [identity(FUNDED, agent)], reviews: [review(FUNDED, agent, 4, 'live run mwfan23a')] });
    expect(r).toMatchObject({ identity_status: 'unverified', review_count: 0, excluded_reasons: { owner: 1 }, trusted: false });
  });
});

describe('looking payments up on chain', () => {
  const rpcOf = (answers: Record<string, RpcTxResult | Error>) => {
    const calls: string[] = [];
    const rpc = vi.fn(async (_m: string, p: unknown) => {
      const { tx_hash, sender_account_id } = p as { tx_hash: string; sender_account_id: string };
      calls.push(`${tx_hash.slice(0, 6)}:${sender_account_id}`);
      const a = answers[`${tx_hash}:${sender_account_id}`] ?? answers[tx_hash];
      if (!a) throw Object.assign(new Error('unknown'), { rpc: true, cause: 'UNKNOWN_TRANSACTION' });
      if (a instanceof Error) throw a;
      return a;
    });
    return { rpc: rpc as unknown as <T>(m: string, p: unknown) => Promise<T>, calls };
  };

  it('asks with each sender in turn and caches a final answer', async () => {
    const { rpc, calls } = rpcOf({ [`${X402}:${AGENT}`]: fx.x402_settlement });
    const lookup = rpcTxLookup(rpc, new MemoryTxCache());
    expect((await lookup(X402, [ROOT, AGENT]))?.payments[0].payer).toBe(ROOT);
    expect(calls).toEqual(['Cym3k2:attestra.testnet', 'Cym3k2:agent.attestra.testnet']);
    await lookup(X402, [ROOT, AGENT]);
    expect(calls).toHaveLength(2);
  });

  it('keeps an unknown hash for a while, never caches a pending transaction, and concludes nothing on errors', async () => {
    let t = 1000;
    const pending = { ...clone(fx.near_transfer), final_execution_status: 'EXECUTED_OPTIMISTIC' };
    const { rpc, calls } = rpcOf({ [TRANSFER]: pending, [FT_CALL]: new Error('fetch failed') });
    const lookup = rpcTxLookup(rpc, new MemoryTxCache(), { notFoundTtlS: 60, now: () => t });
    expect(await lookup(X402, [ROOT])).toEqual({ found: false, final: false, payments: [] });
    await lookup(X402, [ROOT]);
    expect(calls.filter((c) => c.startsWith('Cym3k2'))).toHaveLength(1);
    t += 61;
    await lookup(X402, [ROOT]);
    expect(calls.filter((c) => c.startsWith('Cym3k2'))).toHaveLength(2);
    expect((await lookup(TRANSFER, [ROOT]))?.final).toBe(false);
    await lookup(TRANSFER, [ROOT]);
    expect(calls.filter((c) => c.startsWith('5D4ZPg'))).toHaveLength(2);
    expect(await lookup(FT_CALL, [STAKER])).toBeNull();
  });

  it('assesses a profile with lookups only for counted reviews that name a transaction', async () => {
    const reviews = [review(AGENT, AGENT, 5, X402), review(STAKER, 'staking.attestra.testnet', 5, FT_CALL), review('bob.testnet', 'staking.attestra.testnet', 5, 'job')];
    const staking = 'staking.attestra.testnet';
    expect(paymentQueries(staking, [identity(staking, staking)], reviews)).toEqual([{ txHash: FT_CALL, senders: [STAKER, staking] }]);
    const { rpc, calls } = rpcOf({ [FT_CALL]: fx.ft_transfer_call });
    const r = await assessReputation({ agent: staking, identities: [identity(staking, staking)], reviews }, rpcTxLookup(rpc), ACCEPTED);
    expect(calls).toEqual([`2mb2KT:${STAKER}`]);
    expect(r).toMatchObject({ review_count: 2, paid_review_count: 1, trusted: true });
  });
});

describe('AttestraClient.getAgentProfile', () => {
  it('runs the rules itself and verifies payments over RPC instead of trusting the indexer', async () => {
    const staking = 'staking.attestra.testnet';
    const id = { ...identity(staking, staking), schema_uid: 'aa'.repeat(32), tx_hash: null, block_height: null, revoke_tx_hash: null };
    const rv = { ...review(STAKER, staking, 5, FT_CALL), schema_uid: 'bb'.repeat(32), tx_hash: null, block_height: null, revoke_tx_hash: null };
    const fake = { ...rv, uid: 'ff'.repeat(32), attester: 'sybil.testnet', data: new SchemaEncoder(KNOWN_SCHEMAS.agentReview.definition).encode({ score: 5, comment: '', job_ref: FT_CALL }) };
    // The indexer claims everything is paid and trusted.
    const lying = { account_id: staking, identity: id, identities: [id], identity_fields: null, reviews: [{ ...rv, paid: true }, { ...fake, paid: true }], trusted: true, delegations: [], authority: null };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.startsWith('http://indexer')) return Response.json(lying);
      const body = JSON.parse(String(init?.body)) as { id: number; params: { tx_hash: string } };
      return Response.json({ jsonrpc: '2.0', id: body.id, result: body.params.tx_hash === FT_CALL ? fx.ft_transfer_call : null });
    });
    try {
      const client = new AttestraClient({ network: 'testnet', indexerUrl: 'http://indexer' });
      const p = await client.getAgentProfile(staking);
      expect(p.success).toBe(true);
      expect(p.data).toMatchObject({ identity_status: 'verified', review_count: 2, paid_review_count: 1, trusted: true });
      expect(p.data!.reviews.map((r) => r.paid)).toEqual([true, false]);
      expect(p.data!.reviews[1].payment_reason).toBe('the transaction is not a payment signed by the reviewer');
      expect((await client.getAgentProfile(staking, { verifyPayments: false })).data?.reviews[1].paid).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('recent payments', () => {
  it('finds the payer recent payments to the agent from the transactions API', async () => {
    const asFastNear = (r: RpcTxResult) => ({ transaction: r.transaction, execution_outcome: { outcome: { executor_id: r.transaction.signer_id, logs: [], status: { SuccessReceiptId: 'x' } } }, receipts: r.receipts_outcome.map((o) => ({ execution_outcome: o })) });
    const f = vi.fn(async (url: string) =>
      url.endsWith('/v0/account')
        ? new Response(`{"account_txs":[{"transaction_hash":"${X402}","tx_block_height":277073500,"tx_block_timestamp":1794317246936695333,"is_delegated_signer":true,"is_success":true},{"transaction_hash":"${TRANSFER}","tx_block_height":277000000,"is_signer":true,"is_success":true}]}`)
        : Response.json({ transactions: [asFastNear(fx.near_transfer), asFastNear(fx.x402_settlement)] }),
    );
    const out = await recentPayments('https://tx.example/', ROOT, [AGENT], { fetchImpl: f as unknown as typeof fetch });
    expect(out).toEqual([{ txHash: X402, blockHeight: 277073500, payment: expect.objectContaining({ payee: AGENT, asset: TOKEN }) }]);
    expect(f.mock.calls.map((c) => c[0])).toEqual(['https://tx.example/v0/account', 'https://tx.example/v0/transactions']);
  });
});

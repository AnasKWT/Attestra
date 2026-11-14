import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AttestraClient, KNOWN_SCHEMAS, SchemaEncoder, knownSchemaUid } from 'attestra';
import { createApi } from '../src/api';
import { loadConfig } from '../src/config';
import { connect, migrate, reset, type Db } from '../src/db';
import { ingestOnce } from '../src/ingest';
import type { TxApi, TxRecord } from '../src/txapi';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/attestra_test';

/** A set TEST_DATABASE_URL must work; the default local database is optional (skipped with a note). */
async function databaseReachable(): Promise<boolean> {
  if (process.env.TEST_DATABASE_URL) return true;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    console.warn(`indexer database tests skipped: no Postgres at ${url} (see apps/indexer/README.md)`);
    return false;
  }
}
const run = (await databaseReachable()) ? describe : describe.skip;

const A = 'attestations.attestra.testnet';
const S = 'schemas.attestra.testnet';
const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'attestra', version: '1.0.0', event, data: [data] })}`;
function rec(hash: string, executor: string, logs: string[], height = 120): TxRecord {
  const o = { id: `${hash}-r`, block_height: height, block_timestamp: '1700000000000000000', index: 0, outcome: { executor_id: executor, logs, status: {}, receipt_ids: [] } };
  return { transaction: { hash, signer_id: 'alice.testnet', receiver_id: executor }, execution_outcome: { ...o, id: hash, outcome: { ...o.outcome, executor_id: 'alice.testnet', logs: [] } }, receipts: [{ receipt: { receipt_id: o.id, receiver_id: executor, predecessor_id: 'alice.testnet' }, execution_outcome: o }] };
}

const identityUid = knownSchemaUid('agentIdentity');
const reviewUid = knownSchemaUid('agentReview');
const identityData = new SchemaEncoder(KNOWN_SCHEMAS.agentIdentity.definition).encode({ name: 'Scout', owner: 'alice.testnet', model: 'm', capabilities: ['verify'], endpoint: 'https://x', description: '' });
const reviewData = new SchemaEncoder(KNOWN_SCHEMAS.agentReview.definition).encode({ score: 4, comment: 'good', job_ref: 'job-1' });

const chainState: Record<string, unknown> = {
  [`get_schema:${identityUid}`]: { uid: identityUid, definition: KNOWN_SCHEMAS.agentIdentity.definition, authority: 'alice.testnet', resolver: null, revocable: true, created_at: 1700000000, status: 'active', blob_hash: null },
  [`get_attestation:a1`]: { uid: 'a1', schema_uid: identityUid, attester: 'alice.testnet', subject: 'scout.testnet', data: identityData, created_at: 1700000000, expiration_time: 0, revoked: false, revocation_time: 0, revoke_at: 0, nonce: 0, ref_uid: null, status: 'active' },
  [`get_attestation:a2`]: { uid: 'a2', schema_uid: reviewUid, attester: 'bob.testnet', subject: 'scout.testnet', data: reviewData, created_at: 1700000001, expiration_time: 0, revoked: false, revocation_time: 0, revoke_at: 0, nonce: 0, ref_uid: 'a1', status: 'active' },
  [`get_authority:alice.testnet`]: { account_id: 'alice.testnet', metadata: 'Alice Labs', kind: 'organization', verified: true, registered_at: 1700000000, verified_at: 1700000000, tier: 'gold', staked: '10', delegate_count: 1 },
  [`get_delegates:alice.testnet`]: [{ authority: 'alice.testnet', delegate: 'scout.testnet', schemas: null, expires_at: 0, max_uses: 0, uses: 0, can_revoke: false, label: 'agent', granted_at: 1, active: true }],
};

class FakeChain extends AttestraClient {
  override async view<T>(_c: string, method: string, args: Record<string, string> = {}): Promise<T> {
    const key = `${method}:${args.uid ?? args.account_id ?? args.authority}`;
    return (chainState[key] ?? null) as T;
  }
}

const txs: Record<string, TxRecord> = {
  t1: rec('t1', S, [ev('schema_registered', { uid: identityUid, authority: 'alice.testnet' })], 110),
  t2: rec('t2', A, [ev('authority_registered', { account_id: 'alice.testnet', metadata: 'Alice Labs' }), ev('delegate_added', { authority: 'alice.testnet', delegate: 'scout.testnet' })], 111),
  t3: rec('t3', A, [ev('attestation_created', { uid: 'a1', attester: 'alice.testnet', subject: 'scout.testnet' })], 112),
  t4: rec('t4', A, [ev('attestation_created', { uid: 'a2', attester: 'bob.testnet', subject: 'scout.testnet' })], 113),
};
const fakeApi = {
  head: async () => 200,
  accountTxs: async (account: string) => Object.values(txs).filter((t) => t.receipts[0].receipt.receiver_id === account).map((t) => ({ hash: t.transaction.hash, height: t.receipts[0].execution_outcome.block_height })),
  transactions: async (hashes: string[]) => hashes.map((h) => txs[h]).filter(Boolean),
} as unknown as TxApi;

run('ingest and API (Postgres)', () => {
  let db: Db;
  const config = { ...loadConfig({}), startHeight: 100, lagBlocks: 0 };
  const deps = () => ({ config, db, api: fakeApi, chain: new FakeChain({ network: 'testnet' }) });
  const api = () => createApi({ db, network: 'testnet', startedAt: Date.now(), chainHead: async () => 205 });

  beforeAll(async () => {
    db = connect(url);
    await migrate(db);
  });
  beforeEach(async () => reset(db));
  afterAll(async () => db.end());

  it('indexes events and serves lists, details, agents and search', async () => {
    expect(await ingestOnce(deps())).toBe(5);
    const app = api();
    const get = async (p: string) => (await app.request(p)).json() as Promise<any>;
    expect((await get('/api/schemas')).pagination.total).toBe(1);
    const atts = await get('/api/attestations?subject=scout.testnet');
    expect(atts.data.map((a: any) => a.uid).sort()).toEqual(['a1', 'a2']);
    expect(atts.data[0].status).toBe('active');
    expect((await get('/api/attestations?status=active')).pagination.total).toBe(2);
    expect((await get('/api/attestations?status=revoked')).pagination.total).toBe(0);
    const one = await get('/api/attestations/a1');
    expect(one.decoded.name).toBe('Scout');
    const agent = await get('/api/agents/scout.testnet');
    expect(agent.identity_fields.capabilities).toEqual(['verify']);
    expect(agent.average_score).toBe(4);
    expect(agent.delegations).toHaveLength(1);
    expect((await get('/api/agents')).pagination.total).toBe(1);
    const auth = await get('/api/authorities/alice.testnet');
    expect(auth.verified).toBe(true);
    expect(auth.attestation_count).toBe(1);
    expect((await get('/api/events?event=attestation_created')).data).toHaveLength(2);
    expect((await get('/api/events?account=bob.testnet')).data).toHaveLength(1);
    expect((await get('/api/search?q=scout')).results.length).toBeGreaterThan(0);
    expect((await get('/api/profile/alice.testnet')).issued).toHaveLength(1);
    expect((await get('/api/stats')).agents).toBe(1);
    expect((await app.request('/api/attestations/zz')).status).toBe(404);
  });

  it('is idempotent across restarts and resyncs', async () => {
    await ingestOnce(deps());
    expect(await ingestOnce(deps())).toBe(0);
    await db.query('delete from cursors');
    expect(await ingestOnce(deps())).toBe(0);
    const [{ n }] = (await db.query('select count(*)::int as n from events')).rows;
    expect(n).toBe(5);
    await reset(db);
    expect(await ingestOnce(deps())).toBe(5);
  });

  it('reports lag and health', async () => {
    await ingestOnce(deps());
    const app = api();
    const status = await (await app.request('/api/status')).json() as any;
    expect(status.lag_blocks).toBe(5);
    expect(status.caught_up).toBe(true);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/live')).status).toBe(200);
  });
});

describe('start height', () => {
  it('starts at the deployment height when START_HEIGHT is empty or 0, as .env.example ships it', () => {
    const deployed = loadConfig({}).startHeight;
    expect(deployed).toBeGreaterThan(0);
    expect(loadConfig({ START_HEIGHT: '0' }).startHeight).toBe(deployed);
    expect(loadConfig({ START_HEIGHT: '' }).startHeight).toBe(deployed);
    expect(loadConfig({ START_HEIGHT: '123' }).startHeight).toBe(123);
  });
});

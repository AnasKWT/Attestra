import { base58Encode, KNOWN_SCHEMAS, keySigner, knownSchemaUid, SchemaEncoder, signDaoMembership, type IndexedAttestation } from 'attestra';
import { describe, expect, it } from 'vitest';
import { createKeeperApp } from '../src/keeper/app';
import { loadKeeperConfig } from '../src/keeper/config';
import { MembershipDesk, Refusal } from '../src/keeper/council';
import { Keeper } from '../src/keeper/keeper';
import type { ChainReader } from '../src/lib/chain';
import { RecentErrors } from '../src/lib/log';
import { FakeIndexer, FakeWriter, quietLog } from './fakes';

const NOW = 1_800_000_000;
const DAO = 'guild.sputnik-v2.testnet';
const A = 'attestations.attestra.testnet';
const KEEPER = 'keeper.attestra.testnet';
const MEMBERSHIP = knownSchemaUid('membership');
const bob = keySigner(`ed25519:${base58Encode(new Uint8Array(32).fill(5))}`);

const row = (attester: string, subject: string, schema = 'ab'.repeat(32)): IndexedAttestation =>
  ({ uid: `${attester.length}`.padEnd(64, 'c'), schema_uid: schema, attester, subject, status: 'active' }) as unknown as IndexedAttestation;

/** The chain as views: the keeper's grant from the DAO and the DAO's storage balance. */
function chain(grant: boolean, storage = '0'): ChainReader {
  return {
    view<T>(contract: string, method: string): Promise<T> {
      if (contract === A && method === 'get_delegate') return Promise.resolve((grant ? { schemas: [MEMBERSHIP], max_uses: 100, uses: 0 } : null) as T);
      if (contract === A && method === 'storage_balance_of') return Promise.resolve({ total: storage, available: storage } as T);
      return Promise.reject(new Error(`unexpected view ${contract}.${method}`));
    },
    balance: () => Promise.resolve(10n ** 24n),
    hasKey: () => Promise.resolve(false),
  };
}

function desk(o: { grant?: boolean; attestations?: IndexedAttestation[]; writer?: FakeWriter | null; storage?: string } = {}) {
  const writer = o.writer === undefined ? new FakeWriter(KEEPER) : o.writer;
  if (writer) {
    const call = writer.call.bind(writer);
    writer.respond = () => null;
    writer.call = async (c, m, a, opts) => ({
      ...(await call(c, m, a, opts)),
      outcome: m === 'attest_on_behalf' ? { receipts_outcome: [{ outcome: { logs: [`EVENT_JSON:${JSON.stringify({ standard: 'attestra', version: '1.0.0', event: 'attestation_created', data: [{ uid: 'ee'.repeat(32) }] })}`] } }] } : undefined,
    });
  }
  const rows = o.attestations ?? [row('verdicts.attestra.testnet', 'bob.testnet')];
  const indexer = {
    listAttestations: (q: { attester?: string; subject?: string; schema?: string }) =>
      Promise.resolve({ data: rows.filter((r) => (!q.attester || r.attester === q.attester) && (!q.subject || r.subject === q.subject) && (!q.schema || r.schema_uid === q.schema)), pagination: { total: 0, limit: 50, offset: 0 } }),
  };
  const d = new MembershipDesk({
    daos: [DAO],
    roles: ['member', 'contributor'],
    attestations: A,
    reader: chain(o.grant ?? true, o.storage),
    writer,
    indexer,
    log: quietLog(),
    hasFullAccessKey: (account, key) => Promise.resolve(account === 'bob.testnet' && key === bob.publicKey),
    nowSecs: () => NOW,
  });
  return { d, writer };
}

const ask = (role = 'member', account = 'bob.testnet', dao = DAO, signer = bob) => signDaoMembership(signer, { dao, account, role, deadline: NOW + 600 }, A);

describe('DAO membership desk', () => {
  it('issues a membership as the DAO, through its scoped delegate grant, after topping up its storage', async () => {
    const { d, writer } = desk();
    const out = await d.request(await ask());
    expect(out).toMatchObject({ dao: DAO, account: 'bob.testnet', role: 'member', attestation: 'ee'.repeat(32) });
    expect(writer!.sent.map((t) => `${t.receiver}.${t.method}`)).toEqual([`${A}.storage_deposit`, `${A}.attest_on_behalf`]);
    const issued = writer!.sent[1].args!;
    expect(issued).toMatchObject({ authority: DAO, schema_uid: MEMBERSHIP, subject: 'bob.testnet', expiration_time: NOW + 365 * 86_400 });
    expect(new SchemaEncoder(KNOWN_SCHEMAS.membership.definition).decode(issued.data as string)).toMatchObject({ organization: DAO, role: 'member' });
    // The keeper never votes: no call ever goes to the DAO.
    expect(writer!.sent.some((t) => t.receiver === DAO)).toBe(false);
    // Asking again before the indexer has the new membership is still refused.
    await expect(d.request(await ask())).rejects.toThrow(/already a member/);
    expect(writer!.sent.filter((t) => t.method === 'attest_on_behalf').length).toBe(1);
  });

  it('refuses requests that break the rules, with the reason', async () => {
    const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: Refusal) => [e.status, e.message] as const);
    expect(await refusal(desk().d.request(await ask('admin')))).toEqual([400, expect.stringMatching(/needs a council vote/)]);
    expect(await refusal(desk().d.request(await ask('member', 'bob.testnet', 'other.sputnik-v2.testnet')))).toEqual([400, expect.stringMatching(/not a DAO this keeper issues for/)]);
    // Signed by someone else's key.
    const mallory = keySigner(`ed25519:${base58Encode(new Uint8Array(32).fill(6))}`);
    expect(await refusal(desk().d.request(await ask('member', 'bob.testnet', DAO, mallory)))).toEqual([403, expect.stringMatching(/not a full-access key/)]);
    // Already a member.
    expect(await refusal(desk({ attestations: [row('verdicts.attestra.testnet', 'bob.testnet'), row(DAO, 'bob.testnet', MEMBERSHIP)] }).d.request(await ask()))).toEqual([409, expect.stringMatching(/already a member/)]);
    // Nobody else vouches: only self-issued attestations.
    expect(await refusal(desk({ attestations: [row('bob.testnet', 'bob.testnet')] }).d.request(await ask()))).toEqual([403, expect.stringMatching(/no other issuer vouches/)]);
  });

  it('needs the council grant and a key', async () => {
    await expect(desk({ grant: false }).d.request(await ask())).rejects.toThrow(/not a delegate of/);
    await expect(desk({ writer: null }).d.request(await ask())).rejects.toThrow(/read-only/);
  });

  it('is on by default only for the deployment DAO', () => {
    expect(loadKeeperConfig({}).daos).toEqual(['attestra.sputnik-v2.testnet']);
    expect(loadKeeperConfig({ KEEPER_DAOS: '' }).daos).toEqual(['attestra.sputnik-v2.testnet']);
    expect(loadKeeperConfig({ KEEPER_DAOS: 'none' }).daos).toEqual([]);
    expect(loadKeeperConfig({ ATTESTRA_ROOT: 'other.testnet' }).daos).toEqual([]);
    expect(loadKeeperConfig({ NEAR_NETWORK: 'mainnet' }).daos).toEqual([]);
    expect(loadKeeperConfig({ KEEPER_DAOS: `${DAO}, x.sputnik-v2.testnet`, KEEPER_DAO_ROLES: 'member' })).toMatchObject({ daos: [DAO, 'x.sputnik-v2.testnet'], daoRoles: ['member'] });
  });

  it('answers over HTTP with the right status', async () => {
    const config = { ...loadKeeperConfig({ KEEPER_DAOS: DAO }), intervalMs: 60_000 };
    const { d, writer } = desk({ storage: '1000000000000000000000000' });
    const reader = chain(true, '1000000000000000000000000');
    const errors = new RecentErrors();
    const keeper = new Keeper({ config, indexer: new FakeIndexer(), reader, writer, log: quietLog(), errors });
    const app = createKeeperApp({ config, keeper, desk: d, reader, writer, errors });
    expect(((await (await app.request('/v1/dao')).json()) as { delegate: string }).delegate).toBe(KEEPER);
    expect((await app.request('/v1/dao/membership', { method: 'POST', body: JSON.stringify({ request: await ask('admin') }) })).status).toBe(400);
    const ok = await app.request('/v1/dao/membership', { method: 'POST', body: JSON.stringify({ request: await ask() }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { attestation: string }).attestation).toBe('ee'.repeat(32));
    expect((await app.request('/v1/dao/membership', { method: 'POST', body: '{}' })).status).toBe(400);
    const idle = createKeeperApp({ config, keeper, desk: d, reader, writer: null, errors });
    expect((await idle.request('/v1/dao/membership', { method: 'POST', body: JSON.stringify({ request: await ask() }) })).status).toBe(503);
  });

  it('issues one membership per account a day, counted only once the account signed', async () => {
    const config = { ...loadKeeperConfig({ KEEPER_DAOS: DAO }), intervalMs: 60_000 };
    const { d, writer } = desk({ storage: '1000000000000000000000000' });
    const reader = chain(true, '1000000000000000000000000');
    const errors = new RecentErrors();
    const keeper = new Keeper({ config, indexer: new FakeIndexer(), reader, writer, log: quietLog(), errors });
    const app = createKeeperApp({ config, keeper, desk: d, reader, writer, errors });
    const post = (request: unknown) => app.request('/v1/dao/membership', { method: 'POST', body: JSON.stringify({ request }) });
    // A request signed in bob's name by another key is refused and does not use bob's limit.
    const eve = keySigner(`ed25519:${base58Encode(new Uint8Array(32).fill(9))}`);
    expect((await post(await ask('member', 'bob.testnet', DAO, eve))).status).toBe(403);
    expect((await post(await ask())).status).toBe(200);
    const again = await post(await ask('contributor'));
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(80_000);
    expect(((await again.json()) as { error: string }).error).toMatch(/^Too Many Requests: memberships are limited to 1 per day for one account/);
    expect(writer!.sent.filter((t) => t.method === 'attest_on_behalf')).toHaveLength(1);
  });
});

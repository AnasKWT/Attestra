/**
 * The explorer's REST API. Lists and profiles come from Postgres; anything can be checked
 * against the chain with the SDK's views or a light client proof.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { KNOWN_SCHEMAS, NEAR_ASSET, RATE_LIMIT_HEADERS, SchemaEncoder, TokenBucket, assessReputation, knownSchemaUid, rateLimit, rpcTxLookup, type Rate, type RpcCall, type TxLookupFn } from 'attestra';
import type { Db } from './db';
import { getMeta, txPaymentCache } from './db';

export interface ApiDeps {
  db: Db;
  network: string;
  /** Current chain height (final), for the lag report. */
  chainHead: () => Promise<number | null>;
  startedAt: number;
  /** JSON-RPC (the SDK client's `rpc`, with archival fallback), to check that a review's job_ref is a real payment; without it no review is paid. */
  rpc?: RpcCall;
  /** Assets a paid review may pay in (`NEAR` and the deployment's payment token); null accepts any. */
  paymentAssets?: string[] | null;
  /** Per client address: every `/api/*` request and, stricter, `/api/search` (default `DEFAULT_LIMITS`). */
  limits?: ApiLimits;
}

export interface ApiLimits {
  /** Client addresses come from the first `X-Forwarded-For` hop (TRUST_PROXY, on behind Caddy). */
  trustProxy: boolean;
  ip: Rate;
  search: Rate;
}

export const DEFAULT_LIMITS: ApiLimits = { trustProxy: false, ip: { limit: 1200, windowMs: 60_000 }, search: { limit: 120, windowMs: 60_000 } };

const now = () => Math.floor(Date.now() / 1000);

/** Attestation status from stored fields and the current time (expiry and scheduled revocation need no transaction). */
export const STATUS_SQL = `case
  when a.state = 'pending' then 'pending'
  when a.revoked or (a.revoke_at > 0 and a.revoke_at <= $NOW) then 'revoked'
  when a.expiration_time > 0 and a.expiration_time < $NOW then 'expired'
  when a.state = 'revoking' then 'revoking'
  else 'active' end`;

export function statusOf(a: { state: string; revoked: boolean; revoke_at: number; expiration_time: number }, t = now()): string {
  if (a.state === 'pending') return 'pending';
  if (a.revoked || (a.revoke_at > 0 && a.revoke_at <= t)) return 'revoked';
  if (a.expiration_time > 0 && a.expiration_time < t) return 'expired';
  if (a.state === 'revoking') return 'revoking';
  return 'active';
}

export function clampPage(limit?: string, offset?: string): { limit: number; offset: number } {
  const l = Math.min(100, Math.max(1, Number.parseInt(limit ?? '20', 10) || 20));
  const o = Math.max(0, Number.parseInt(offset ?? '0', 10) || 0);
  return { limit: l, offset: o };
}

const num = (v: unknown) => (v === null || v === undefined ? v : Number(v));

function attestationRow(r: Record<string, unknown>) {
  const out = {
    uid: r.uid as string,
    schema_uid: r.schema_uid as string,
    attester: r.attester as string,
    subject: r.subject as string,
    data: r.data as string,
    created_at: Number(r.created_at),
    expiration_time: num(r.expiration_time),
    revoked: Boolean(r.revoked) || (Number(r.revoke_at) > 0 && Number(r.revoke_at) <= now()),
    revocation_time: Number(r.revocation_time) || (Number(r.revoke_at) > 0 && Number(r.revoke_at) <= now() ? Number(r.revoke_at) : 0),
    revoke_at: num(r.revoke_at),
    nonce: num(r.nonce),
    ref_uid: r.ref_uid,
    status: statusOf({ state: String(r.state), revoked: Boolean(r.revoked), revoke_at: Number(r.revoke_at), expiration_time: Number(r.expiration_time) }),
    tx_hash: r.tx_hash,
    block_height: num(r.block_height),
    revoke_tx_hash: r.revoke_tx_hash,
  };
  return out;
}

function schemaRow(r: Record<string, unknown>) {
  return {
    uid: r.uid,
    definition: r.definition,
    authority: r.authority,
    resolver: r.resolver,
    revocable: r.revocable,
    created_at: num(r.created_at),
    status: r.status,
    blob_hash: r.blob_hash,
    attestation_count: Number(r.attestation_count ?? 0),
    tx_hash: r.tx_hash,
    block_height: num(r.block_height),
  };
}

function authorityRow(r: Record<string, unknown>) {
  return {
    account_id: r.account_id,
    metadata: r.metadata,
    kind: r.kind,
    verified: r.verified,
    registered_at: num(r.registered_at),
    verified_at: num(r.verified_at),
    tier: r.tier,
    staked: r.staked,
    delegate_count: Number(r.delegate_count ?? 0),
    schema_count: Number(r.schema_count ?? 0),
    attestation_count: Number(r.attestation_count ?? 0),
    tx_hash: r.tx_hash,
  };
}

function decode(definition: string, data: string): Record<string, unknown> | null {
  try {
    return new SchemaEncoder(definition).decode(data);
  } catch {
    return null;
  }
}

export function createApi(deps: ApiDeps) {
  const app = new Hono();
  app.use('*', cors({ origin: '*', exposeHeaders: RATE_LIMIT_HEADERS }));
  // Per client address, never on /live or /health: generous for pages and agents, stricter for
  // search (several pattern scans per request).
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const search = new TokenBucket(limits.search);
  app.use(
    '/api/*',
    rateLimit({
      what: 'indexer requests',
      trustProxy: limits.trustProxy,
      rules: [{ limiter: new TokenBucket(limits.ip) }, { limiter: search, key: (c, address) => (c.req.path === '/api/search' ? address : undefined), what: 'searches', scope: 'from one address' }],
    }),
  );
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => deps.db.query<T>(sql, params).then((r) => r.rows);
  const txLookup: TxLookupFn = deps.rpc ? rpcTxLookup(deps.rpc, txPaymentCache(deps.db)) : async () => null;
  const paymentAssets = deps.paymentAssets === undefined ? [NEAR_ASSET] : deps.paymentAssets;

  app.get('/live', (c) => c.json({ ok: true }));

  app.get('/health', async (c) => {
    const status = await indexStatus();
    return c.json({ ok: status.caught_up, service: 'indexer', uptime_s: Math.floor((Date.now() - deps.startedAt) / 1000), ...status }, status.caught_up ? 200 : 503);
  });

  async function indexStatus() {
    const last = Number((await getMeta(deps.db, 'last_block')) ?? 0) || null;
    const lastPass = Number((await getMeta(deps.db, 'last_pass')) ?? 0) || null;
    const head = await deps.chainHead().catch(() => null);
    const lag = head && last ? Math.max(0, head - last) : null;
    return {
      network: deps.network,
      last_block: last,
      chain_head: head,
      lag_blocks: lag,
      lag_seconds: lag === null ? null : Math.round(lag * 0.6),
      last_pass_ms_ago: lastPass ? Date.now() - lastPass : null,
      caught_up: lag !== null && lag < 120 && lastPass !== null && Date.now() - lastPass < 120_000,
    };
  }

  app.get('/api/status', async (c) => c.json(await indexStatus()));

  app.get('/api/stats', async (c) => {
    const [row] = await q<Record<string, string>>(
      `select (select count(*) from schemas where status = 'active') as schemas,
              (select count(*) from attestations where state <> 'pending') as attestations,
              (select count(*) from authorities) as authorities,
              (select count(*) from events) as events,
              (select count(distinct subject) from attestations where schema_uid = $1) as agents,
              (select max(block_height) from events) as last_block,
              (select max(block_timestamp) from events) as last_block_time`,
      [knownSchemaUid('agentIdentity')],
    );
    return c.json(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null ? null : Number(v)])));
  });

  app.get('/api/schemas', async (c) => {
    const { limit, offset } = clampPage(c.req.query('limit'), c.req.query('offset'));
    const where: string[] = ["s.status = 'active'"];
    const params: unknown[] = [];
    const authority = c.req.query('authority');
    const resolver = c.req.query('resolver');
    const search = c.req.query('search');
    if (authority) where.push(`s.authority = $${params.push(authority)}`);
    if (resolver) where.push(`s.resolver = $${params.push(resolver)}`);
    if (search) where.push(`(s.uid ilike $${params.push(`%${search}%`)} or s.definition ilike $${params.length} or s.authority ilike $${params.length})`);
    const w = where.join(' and ');
    const rows = await q(
      `select s.*, (select count(*) from attestations a where a.schema_uid = s.uid and a.state <> 'pending') as attestation_count
       from schemas s where ${w} order by s.created_at desc, s.uid limit ${limit} offset ${offset}`,
      params,
    );
    const [{ total }] = await q<{ total: string }>(`select count(*) as total from schemas s where ${w}`, params);
    return c.json({ data: rows.map(schemaRow), pagination: { total: Number(total), limit, offset } });
  });

  app.get('/api/schemas/:uid', async (c) => {
    const uid = c.req.param('uid').replace(/^0x/, '').toLowerCase();
    const rows = await q(`select s.*, (select count(*) from attestations a where a.schema_uid = s.uid and a.state <> 'pending') as attestation_count from schemas s where s.uid = $1`, [uid]);
    if (!rows[0]) return c.json({ error: 'schema not found' }, 404);
    return c.json(schemaRow(rows[0]));
  });

  app.get('/api/attestations', async (c) => {
    const { limit, offset } = clampPage(c.req.query('limit'), c.req.query('offset'));
    const where: string[] = ["a.state <> 'pending'"];
    const params: unknown[] = [];
    for (const [key, col] of [
      ['schema', 'schema_uid'],
      ['attester', 'attester'],
      ['subject', 'subject'],
    ] as const) {
      const v = c.req.query(key);
      if (v) where.push(`a.${col} = $${params.push(key === 'schema' ? v.replace(/^0x/, '').toLowerCase() : v)}`);
    }
    const status = c.req.query('status');
    if (status) {
      const statusSql = STATUS_SQL.replaceAll('$NOW', `$${params.push(now())}`);
      where.push(`(${statusSql}) = $${params.push(status)}`);
    }
    const w = where.join(' and ');
    const rows = await q(`select a.* from attestations a where ${w} order by a.created_at desc, a.uid limit ${limit} offset ${offset}`, params);
    const [{ total }] = await q<{ total: string }>(`select count(*) as total from attestations a where ${w}`, params);
    return c.json({ data: rows.map(attestationRow), pagination: { total: Number(total), limit, offset } });
  });

  app.get('/api/attestations/:uid', async (c) => {
    const uid = c.req.param('uid').replace(/^0x/, '').toLowerCase();
    const rows = await q(`select a.*, s.definition from attestations a left join schemas s on s.uid = a.schema_uid where a.uid = $1`, [uid]);
    if (!rows[0]) return c.json({ error: 'attestation not found' }, 404);
    const r = rows[0];
    return c.json({ ...attestationRow(r), decoded: r.definition ? decode(String(r.definition), String(r.data)) : null, definition: r.definition ?? null });
  });

  app.get('/api/authorities', async (c) => {
    const { limit, offset } = clampPage(c.req.query('limit'), c.req.query('offset'));
    const where: string[] = ['true'];
    const params: unknown[] = [];
    const verified = c.req.query('verified');
    const kind = c.req.query('kind');
    if (verified !== undefined) where.push(`au.verified = $${params.push(verified === 'true')}`);
    if (kind) where.push(`au.kind = $${params.push(kind)}`);
    const w = where.join(' and ');
    const rows = await q(
      `select au.*, (select count(*) from schemas s where s.authority = au.account_id and s.status = 'active') as schema_count,
              (select count(*) from attestations a where a.attester = au.account_id and a.state <> 'pending') as attestation_count
       from authorities au where ${w} order by au.verified desc, au.registered_at desc limit ${limit} offset ${offset}`,
      params,
    );
    const [{ total }] = await q<{ total: string }>(`select count(*) as total from authorities au where ${w}`, params);
    return c.json({ data: rows.map(authorityRow), pagination: { total: Number(total), limit, offset } });
  });

  app.get('/api/authorities/:account', async (c) => {
    const id = c.req.param('account');
    const rows = await q(
      `select au.*, (select count(*) from schemas s where s.authority = au.account_id and s.status = 'active') as schema_count,
              (select count(*) from attestations a where a.attester = au.account_id and a.state <> 'pending') as attestation_count
       from authorities au where au.account_id = $1`,
      [id],
    );
    if (!rows[0]) return c.json({ error: 'authority not found' }, 404);
    const delegates = await q<{ record: unknown }>('select record from delegates where authority = $1 order by delegate', [id]);
    return c.json({ ...authorityRow(rows[0]), delegates: delegates.map((d) => d.record) });
  });

  app.get('/api/events', async (c) => {
    const { limit, offset } = clampPage(c.req.query('limit'), c.req.query('offset'));
    const where: string[] = ['true'];
    const params: unknown[] = [];
    const event = c.req.query('event');
    const contract = c.req.query('contract');
    const account = c.req.query('account');
    const uid = c.req.query('uid');
    if (event) where.push(`e.event = any($${params.push(event.split(','))})`);
    if (contract) where.push(`e.contract = $${params.push(contract)}`);
    if (account) where.push(`$${params.push(account)} = any(e.accounts)`);
    if (uid) where.push(`e.uid = $${params.push(uid.replace(/^0x/, '').toLowerCase())}`);
    const w = where.join(' and ');
    const rows = await q(`select e.* from events e where ${w} order by e.block_height desc, e.id desc limit ${limit} offset ${offset}`, params);
    const [{ total }] = await q<{ total: string }>(`select count(*) as total from events e where ${w}`, params);
    return c.json({
      data: rows.map((r) => ({ ...r, id: Number(r.id), block_height: Number(r.block_height), block_timestamp: Number(r.block_timestamp) })),
      pagination: { total: Number(total), limit, offset },
    });
  });

  app.get('/api/profile/:account', async (c) => {
    const id = c.req.param('account');
    const [authority] = await q(`select au.* from authorities au where au.account_id = $1`, [id]);
    const schemas = await q(`select s.*, 0 as attestation_count from schemas s where s.authority = $1 and s.status = 'active' order by s.created_at desc limit 100`, [id]);
    const issued = await q(`select a.* from attestations a where a.attester = $1 and a.state <> 'pending' order by a.created_at desc limit 100`, [id]);
    const received = await q(`select a.* from attestations a where a.subject = $1 and a.state <> 'pending' order by a.created_at desc limit 100`, [id]);
    return c.json({
      account_id: id,
      authority: authority ? authorityRow(authority) : null,
      schemas: schemas.map(schemaRow),
      issued: issued.map(attestationRow),
      received: received.map(attestationRow),
    });
  });

  /** An agent's profile under the reputation rules in the SDK's `reputation.ts`. */
  async function agentProfile(id: string) {
    const identities = await q(
      `select a.* from attestations a where a.schema_uid = $1 and a.subject = $2 and a.state = 'active' and not a.revoked order by a.created_at desc limit 20`,
      [knownSchemaUid('agentIdentity'), id],
    );
    const reviews = await q(`select a.* from attestations a where a.schema_uid = $1 and a.subject = $2 and a.state <> 'pending' order by a.created_at desc limit 100`, [knownSchemaUid('agentReview'), id]);
    const delegations = await q<{ record: Record<string, unknown> }>('select record from delegates where delegate = $1', [id]);
    const [authority] = await q(`select au.* from authorities au where au.account_id = $1`, [id]);
    const identityRows = identities.map(attestationRow).filter((r) => r.status === 'active');
    const reputation = await assessReputation({ agent: id, identities: identityRows, reviews: reviews.map(attestationRow) }, txLookup, { acceptedAssets: paymentAssets });
    return {
      account_id: id,
      ...reputation,
      identities: identityRows,
      delegations: delegations.map((d) => d.record),
      authority: authority ? authorityRow(authority) : null,
    };
  }

  app.get('/api/agents', async (c) => {
    const { limit, offset } = clampPage(c.req.query('limit'), c.req.query('offset'));
    const ids = await q<{ subject: string }>(
      `select subject from attestations where schema_uid = $1 and state = 'active' and not revoked group by subject order by max(created_at) desc limit ${limit} offset ${offset}`,
      [knownSchemaUid('agentIdentity')],
    );
    const [{ total }] = await q<{ total: string }>(`select count(distinct subject) as total from attestations where schema_uid = $1 and state = 'active' and not revoked`, [knownSchemaUid('agentIdentity')]);
    return c.json({ data: await Promise.all(ids.map((r) => agentProfile(r.subject))), pagination: { total: Number(total), limit, offset } });
  });

  app.get('/api/agents/:account', async (c) => c.json(await agentProfile(c.req.param('account'))));

  app.get('/api/search', async (c) => {
    const term = (c.req.query('q') ?? '').trim();
    if (term.length < 2) return c.json({ results: [] });
    const like = `%${term}%`;
    const hex = term.replace(/^0x/, '').toLowerCase();
    const results: Array<{ type: string; id: string; label: string }> = [];
    for (const r of await q<{ uid: string; definition: string }>(`select uid, definition from schemas where (uid like $1 or definition ilike $2) and status = 'active' limit 5`, [`${hex}%`, like])) {
      results.push({ type: 'schema', id: r.uid, label: r.definition });
    }
    for (const r of await q<{ uid: string; subject: string }>(`select uid, subject from attestations where uid like $1 limit 5`, [`${hex}%`])) {
      results.push({ type: 'attestation', id: r.uid, label: `about ${r.subject}` });
    }
    for (const r of await q<{ account_id: string; metadata: string }>(`select account_id, metadata from authorities where account_id ilike $1 or metadata ilike $1 limit 5`, [like])) {
      results.push({ type: 'authority', id: r.account_id, label: r.metadata });
    }
    const accounts = await q<{ id: string }>(
      `select distinct subject as id from attestations where subject ilike $1 union select distinct attester from attestations where attester ilike $1 limit 5`,
      [like],
    );
    for (const r of accounts) if (!results.some((x) => x.id === r.id)) results.push({ type: 'account', id: r.id, label: 'account' });
    return c.json({ results });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => c.json({ error: err.message }, 500));
  return app;
}

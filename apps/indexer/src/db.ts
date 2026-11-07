/** Postgres access: migrations, event inserts and record upserts. */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { AttestationRecord, AuthorityRecord, DelegateRecord, SchemaRecord } from '@attestra/sdk';
import type { EventRow } from './events';

export type Db = pg.Pool;

export function connect(url: string, max = 5): Db {
  return new pg.Pool({ connectionString: url, max });
}

export async function migrate(db: Db): Promise<void> {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await db.query(readFileSync(`${dir}${f}`, 'utf8'));
  }
}

/** Removes every indexed row (the resync path); the chain is the source of truth. */
export async function reset(db: Db): Promise<void> {
  await db.query('truncate cursors, events, schemas, attestations, authorities, delegates, meta restart identity');
}

export async function getCursor(db: Db, account: string): Promise<number | null> {
  const r = await db.query<{ height: string }>('select height from cursors where account = $1', [account]);
  return r.rows[0] ? Number(r.rows[0].height) : null;
}

export async function setCursor(db: Db, account: string, height: number): Promise<void> {
  await db.query('insert into cursors (account, height) values ($1, $2) on conflict (account) do update set height = excluded.height', [account, height]);
}

/** Inserts events; returns the ones that were new. */
export async function insertEvents(db: Db, rows: EventRow[]): Promise<EventRow[]> {
  const fresh: EventRow[] = [];
  for (const r of rows) {
    const res = await db.query(
      `insert into events (receipt_id, log_index, tx_hash, signer_id, contract, standard, event, data, uid, accounts, block_height, block_timestamp)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (receipt_id, log_index) do nothing returning id`,
      [r.receipt_id, r.log_index, r.tx_hash, r.signer_id, r.contract, r.standard, r.event, r.data, r.uid, r.accounts, r.block_height, r.block_timestamp],
    );
    if (res.rowCount) fresh.push(r);
  }
  return fresh;
}

export async function upsertSchema(db: Db, s: SchemaRecord, tx?: { hash: string; height: number }): Promise<void> {
  await db.query(
    `insert into schemas (uid, definition, authority, resolver, revocable, created_at, status, blob_hash, tx_hash, block_height)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (uid) do update set status = excluded.status, definition = excluded.definition,
       tx_hash = coalesce(schemas.tx_hash, excluded.tx_hash), block_height = coalesce(schemas.block_height, excluded.block_height)`,
    [s.uid, s.definition, s.authority, s.resolver, s.revocable, s.created_at, s.status, s.blob_hash, tx?.hash ?? null, tx?.height ?? null],
  );
}

export async function deleteSchema(db: Db, uid: string): Promise<void> {
  await db.query('delete from schemas where uid = $1', [uid]);
}

/** `state` keeps the stored lifecycle (pending, active, revoking); time-based status is computed on read. */
export async function upsertAttestation(db: Db, a: AttestationRecord, tx?: { hash: string; height: number; revoke?: boolean }): Promise<void> {
  const state = a.status === 'pending' ? 'pending' : a.status === 'revoking' ? 'revoking' : 'active';
  await db.query(
    `insert into attestations (uid, schema_uid, attester, subject, data, created_at, expiration_time, revoked, revocation_time, revoke_at, nonce, ref_uid, state, tx_hash, block_height, revoke_tx_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (uid) do update set revoked = excluded.revoked, revocation_time = excluded.revocation_time, revoke_at = excluded.revoke_at,
       state = excluded.state, tx_hash = coalesce(attestations.tx_hash, excluded.tx_hash), block_height = coalesce(attestations.block_height, excluded.block_height),
       revoke_tx_hash = coalesce(excluded.revoke_tx_hash, attestations.revoke_tx_hash)`,
    [
      a.uid,
      a.schema_uid,
      a.attester,
      a.subject,
      a.data,
      a.created_at,
      a.expiration_time,
      a.revoked,
      a.revocation_time,
      a.revoke_at,
      a.nonce,
      a.ref_uid,
      state,
      tx && !tx.revoke ? tx.hash : null,
      tx && !tx.revoke ? tx.height : null,
      tx?.revoke ? tx.hash : null,
    ],
  );
}

export async function deleteAttestation(db: Db, uid: string): Promise<void> {
  await db.query('delete from attestations where uid = $1', [uid]);
}

export async function upsertAuthority(db: Db, a: AuthorityRecord, txHash?: string): Promise<void> {
  await db.query(
    `insert into authorities (account_id, metadata, kind, verified, registered_at, verified_at, tier, staked, delegate_count, tx_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (account_id) do update set metadata = excluded.metadata, kind = excluded.kind, verified = excluded.verified,
       verified_at = excluded.verified_at, tier = excluded.tier, staked = excluded.staked, delegate_count = excluded.delegate_count,
       tx_hash = coalesce(authorities.tx_hash, excluded.tx_hash)`,
    [a.account_id, a.metadata, a.kind, a.verified, a.registered_at, a.verified_at, a.tier, a.staked, a.delegate_count, txHash ?? null],
  );
}

export async function replaceDelegates(db: Db, authority: string, list: DelegateRecord[]): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query('delete from delegates where authority = $1', [authority]);
    for (const d of list) {
      await client.query('insert into delegates (authority, delegate, record) values ($1,$2,$3)', [authority, d.delegate, d]);
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function setMeta(db: Db, key: string, value: string): Promise<void> {
  await db.query('insert into meta (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value', [key, value]);
}

export async function getMeta(db: Db, key: string): Promise<string | null> {
  const r = await db.query<{ value: string }>('select value from meta where key = $1', [key]);
  return r.rows[0]?.value ?? null;
}

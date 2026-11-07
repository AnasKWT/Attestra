/**
 * The ingest loop. For every Attestra contract account it reads the transactions that touched the
 * account since its cursor, stores their NEP-297 events, and re-reads every record an event
 * touched from the contract views. Re-reading makes the loop idempotent: restarting, overlapping
 * windows and a full resync all converge to what the chain says.
 */

import type { AttestationRecord, AttestraClient, AuthorityRecord, DelegateRecord, SchemaRecord } from '@attestra/sdk';
import type { IndexerConfig } from './config';
import * as db from './db';
import { extractEvents, refreshTargets, type EventRow } from './events';
import type { TxApi } from './txapi';

/** Re-scan this many blocks below each cursor, so a transaction whose later receipts were still executing gets its events. */
const OVERLAP = 30;
/** Largest height window read per account per pass. */
const WINDOW = 50_000;

export interface IngestDeps {
  config: IndexerConfig;
  db: db.Db;
  api: TxApi;
  chain: AttestraClient;
  log?: (msg: string) => void;
}

export async function refresh(deps: IngestDeps, row: Pick<EventRow, 'event' | 'data' | 'tx_hash' | 'block_height'>): Promise<void> {
  const t = refreshTargets(row as EventRow);
  const tx = row.tx_hash ? { hash: row.tx_hash, height: row.block_height } : undefined;
  const c = deps.chain.contracts;
  if (t.schema) {
    const s = await deps.chain.view<SchemaRecord | null>(c.schemas, 'get_schema', { uid: t.schema });
    if (s) await db.upsertSchema(deps.db, s, tx);
    else await db.deleteSchema(deps.db, t.schema);
  }
  if (t.attestation) {
    const a = await deps.chain.view<AttestationRecord | null>(c.attestations, 'get_attestation', { uid: t.attestation });
    if (a) await db.upsertAttestation(deps.db, a, tx && { ...tx, revoke: row.event === 'attestation_revoked' });
    else await db.deleteAttestation(deps.db, t.attestation);
  }
  if (t.authority) {
    const a = await deps.chain.view<AuthorityRecord | null>(c.attestations, 'get_authority', { account_id: t.authority });
    if (a) await db.upsertAuthority(deps.db, a, row.event === 'authority_registered' ? row.tx_hash : undefined);
  }
  if (t.delegatesOf) {
    const list = await deps.chain.view<DelegateRecord[]>(c.attestations, 'get_delegates', { authority: t.delegatesOf });
    await db.replaceDelegates(deps.db, t.delegatesOf, list ?? []);
  }
}

/** One pass over every account. Returns the number of new events. */
export async function ingestOnce(deps: IngestDeps): Promise<number> {
  const head = (await deps.api.head()) - deps.config.lagBlocks;
  const contracts = new Set(deps.config.accounts);
  let total = 0;
  for (const account of deps.config.accounts) {
    const cursor = await db.getCursor(deps.db, account);
    const from = cursor === null ? deps.config.startHeight : Math.max(deps.config.startHeight, cursor - OVERLAP);
    if (from > head) continue;
    const to = Math.min(head, from + WINDOW);
    const txs = await deps.api.accountTxs(account, from, to);
    const hashes = [...new Set(txs.map((t) => t.hash))];
    const records = await deps.api.transactions(hashes);
    const rows = records
      .flatMap((r) => extractEvents(r, contracts))
      .sort((a, b) => a.block_height - b.block_height || a.receipt_id.localeCompare(b.receipt_id) || a.log_index - b.log_index);
    const fresh = await db.insertEvents(deps.db, rows);
    for (const row of fresh) await refresh(deps, row);
    total += fresh.length;
    await db.setCursor(deps.db, account, to);
    if (fresh.length) deps.log?.(`${account}: ${fresh.length} new events up to ${to}`);
  }
  await db.setMeta(deps.db, 'last_block', String(head));
  await db.setMeta(deps.db, 'last_pass', String(Date.now()));
  return total;
}

/** Re-reads every attestation with a scheduled revocation or an expiry that has passed, so stored state matches the chain. */
export async function refreshDue(deps: IngestDeps): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const r = await deps.db.query<{ uid: string }>(
    `select uid from attestations where revoked = false and ((revoke_at > 0 and revoke_at <= $1) or state <> 'active') limit 200`,
    [now],
  );
  for (const { uid } of r.rows) {
    await refresh(deps, { event: 'attestation_created', data: { uid }, tx_hash: '', block_height: 0 });
  }
  return r.rows.length;
}

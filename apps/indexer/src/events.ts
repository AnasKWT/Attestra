/** Parses NEP-297 log lines from execution outcomes into rows for the events table. */

import type { TxRecord } from './txapi';

export interface EventRow {
  receipt_id: string;
  log_index: number;
  tx_hash: string;
  signer_id: string;
  contract: string;
  standard: string;
  event: string;
  data: Record<string, unknown>;
  uid: string | null;
  accounts: string[];
  block_height: number;
  block_timestamp: number;
}

const ACCOUNT_KEYS = [
  'authority',
  'attester',
  'subject',
  'actor',
  'revoker',
  'account_id',
  'delegate',
  'by',
  'owner_id',
  'proposer',
  'member',
  'executor',
  'created_by',
  'payer',
];

/** Parses `EVENT_JSON:{...}`; returns null for any other line or malformed JSON. */
export function parseEventLog(line: string): { standard: string; event: string; data: Record<string, unknown> } | null {
  if (!line.startsWith('EVENT_JSON:')) return null;
  try {
    const j = JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard?: string; event?: string; data?: unknown };
    if (typeof j.standard !== 'string' || typeof j.event !== 'string') return null;
    const data = Array.isArray(j.data) ? (j.data[0] ?? {}) : (j.data ?? {});
    return { standard: j.standard, event: j.event, data: data as Record<string, unknown> };
  } catch {
    return null;
  }
}

function uidOf(event: string, data: Record<string, unknown>): string | null {
  const v = data.uid ?? data.attestation_uid ?? data.request_id ?? data.hash ?? data.schema_uid ?? null;
  if (event.startsWith('schema_')) return (data.uid as string) ?? null;
  if (event === 'credential_minted' || event === 'credential_burned') return (data.attestation_uid as string) ?? (v as string) ?? null;
  return typeof v === 'string' ? v : null;
}

function accountsOf(data: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const k of ACCOUNT_KEYS) {
    const v = data[k];
    if (typeof v === 'string' && v) out.add(v);
  }
  if (Array.isArray(data.members)) for (const m of data.members) if (typeof m === 'string') out.add(m);
  return [...out];
}

/** Every Attestra (and NEP-171) event a transaction's receipts logged on one of `contracts`. */
export function extractEvents(tx: TxRecord, contracts: Set<string>): EventRow[] {
  const rows: EventRow[] = [];
  const outcomes = [tx.execution_outcome, ...tx.receipts.map((r) => r.execution_outcome)];
  for (const o of outcomes) {
    if (!o || !contracts.has(o.outcome.executor_id)) continue;
    o.outcome.logs.forEach((line, i) => {
      const ev = parseEventLog(line);
      if (!ev || (ev.standard !== 'attestra' && ev.standard !== 'nep171')) return;
      rows.push({
        receipt_id: o.id,
        log_index: i,
        tx_hash: tx.transaction.hash,
        signer_id: tx.transaction.signer_id,
        contract: o.outcome.executor_id,
        standard: ev.standard,
        event: ev.event,
        data: ev.data,
        uid: uidOf(ev.event, ev.data),
        accounts: accountsOf(ev.data),
        block_height: o.block_height,
        block_timestamp: Math.floor(Number(BigInt(o.block_timestamp) / 1_000_000n)),
      });
    });
  }
  return rows;
}

/** What the indexer must re-read from the chain after an event. */
export function refreshTargets(row: EventRow): { schema?: string; attestation?: string; authority?: string; delegatesOf?: string } {
  const d = row.data;
  switch (row.event) {
    case 'schema_pending':
    case 'schema_registered':
    case 'schema_rejected':
      return { schema: d.uid as string };
    case 'attestation_pending':
    case 'attestation_created':
    case 'attestation_rejected':
    case 'attestation_revoked':
    case 'attestation_expired':
    case 'revocation_scheduled':
    case 'revocation_rejected':
      return { attestation: d.uid as string };
    case 'authority_registered':
    case 'authority_verified':
    case 'authority_tier':
      return { authority: d.account_id as string };
    case 'multisig_created':
      return { authority: d.id as string };
    case 'delegate_added':
    case 'delegate_removed':
      return { delegatesOf: d.authority as string, authority: d.authority as string };
    default:
      return {};
  }
}

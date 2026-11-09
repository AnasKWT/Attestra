/** Fakes for the chain and the indexer, so every test runs without a network. */

import type { IndexedAttestation, IndexedEvent, IndexerStatus, Paginated } from '@attestra/sdk';
import type { SignedDelegateAction } from 'near-kit';
import type { ChainReader, ChainWriter, TxResult } from '../src/lib/chain';
import type { Logger } from '../src/lib/log';

export class FakeReader implements ChainReader {
  views = new Map<string, unknown>();
  balances = new Map<string, bigint | null>();
  keys = new Map<string, string[]>();
  failViews = false;

  view<T>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.failViews) return Promise.reject(new Error('fetch failed'));
    const key = `${contract}:${method}:${String(args.uid ?? args.account_id ?? '')}`;
    return Promise.resolve((this.views.has(key) ? this.views.get(key) : null) as T);
  }

  setView(contract: string, method: string, arg: string, value: unknown) {
    this.views.set(`${contract}:${method}:${arg}`, value);
  }

  balance(accountId: string): Promise<bigint | null> {
    return Promise.resolve(this.balances.has(accountId) ? (this.balances.get(accountId) as bigint | null) : null);
  }

  hasKey(accountId: string, publicKey: string): Promise<boolean> {
    return Promise.resolve((this.keys.get(accountId) ?? []).includes(publicKey));
  }
}

export interface SentTx {
  kind: 'call' | 'transfer' | 'relay';
  receiver: string;
  method?: string;
  args?: Record<string, unknown>;
  deposit?: bigint;
  gas?: bigint;
  amount?: bigint;
}

export class FakeWriter implements ChainWriter {
  readonly accountId: string;
  readonly lanes = 1;
  readonly gasKey = false;
  sent: SentTx[] = [];
  /** Returns the call's value, or throws to simulate a failure. */
  respond: (tx: SentTx) => unknown = () => ({ uid: 'u', status: 'created' });

  constructor(accountId = 'service.testnet') {
    this.accountId = accountId;
  }

  queueLength(): number {
    return 0;
  }

  private async record(tx: SentTx): Promise<TxResult> {
    this.sent.push(tx);
    const value = this.respond(tx);
    return { txHash: `tx${this.sent.length}`, value };
  }

  call(contract: string, method: string, args: Record<string, unknown>, opts: { deposit?: bigint; gas?: bigint } = {}) {
    return this.record({ kind: 'call', receiver: contract, method, args, deposit: opts.deposit ?? 0n, gas: opts.gas });
  }

  transfer(receiver: string, amount: bigint) {
    return this.record({ kind: 'transfer', receiver, amount });
  }

  relay(signed: SignedDelegateAction) {
    return this.record({ kind: 'relay', receiver: signed.signedDelegate.delegateAction.receiverId });
  }
}

/** A panic as near-kit reports it (the SDK's `errorMessage` reads `panic`). */
export function panic(message: string): Error {
  return Object.assign(new Error(`Smart contract panicked: ${message}`), { panic: message, name: 'FunctionCallError' });
}

export function attestation(uid: string, over: Partial<IndexedAttestation> = {}): IndexedAttestation {
  return {
    uid,
    schema_uid: 'a'.repeat(64),
    attester: 'alice.testnet',
    subject: 'bob.testnet',
    data: '',
    created_at: 1_700_000_000,
    expiration_time: 0,
    revoked: false,
    revocation_time: 0,
    revoke_at: 0,
    nonce: 0,
    ref_uid: null,
    status: 'active',
    tx_hash: 'T',
    block_height: 1,
    revoke_tx_hash: null,
    ...over,
  };
}

const page = <T>(data: T[]): Paginated<T> => ({ data, pagination: { total: data.length, limit: 100, offset: 0 } });

export class FakeIndexer {
  rows: IndexedAttestation[] = [];
  /** uid -> events recorded for it. */
  events = new Map<string, IndexedEvent[]>();
  lag: number | null = 2;
  fail = false;

  async listAttestations(q: { status?: string; limit?: number; offset?: number }): Promise<Paginated<IndexedAttestation>> {
    if (this.fail) throw new Error('indexer answered 500 for /api/attestations');
    const rows = q.status ? this.rows.filter((r) => r.status === q.status) : this.rows;
    return page(rows.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 20)));
  }

  async listEvents(q: { event?: string; uid?: string }): Promise<Paginated<IndexedEvent>> {
    if (this.fail) throw new Error('indexer answered 500 for /api/events');
    return page((this.events.get(q.uid ?? '') ?? []).filter((e) => !q.event || e.event === q.event));
  }

  async status(): Promise<IndexerStatus> {
    if (this.fail) throw new Error('indexer answered 500 for /api/status');
    return { network: 'testnet', last_block: 100, chain_head: 100 + (this.lag ?? 0), lag_blocks: this.lag, lag_seconds: null, caught_up: true };
  }
}

export function event(uid: string, name: string): IndexedEvent {
  return { id: 1, event: name, contract: 'attestations.attestra.testnet', data: { uid }, uid, accounts: [], standard: 'attestra', log_index: 0, tx_hash: 'E', receipt_id: 'R', block_height: 1, block_timestamp: 1, signer_id: 'keeper.attestra.testnet' };
}

export function quietLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const log = ((m: string) => {
    lines.push(m);
  }) as Logger & { lines: string[] };
  log.lines = lines;
  return log;
}

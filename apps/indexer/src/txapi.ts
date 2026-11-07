/**
 * FastNEAR's transactions API:
 * - `POST /v0/blocks` newest committed blocks (bounds what the other endpoints know),
 * - `POST /v0/account` every transaction that touched an account, by inclusion height,
 * - `POST /v0/transactions` up to 20 transactions with every receipt executed so far.
 * Without a key it allows about 60 requests a minute per IP, so requests are paced and 429s retried.
 */

export interface TxOutcome {
  id: string;
  block_height: number;
  block_timestamp: string;
  index: number;
  outcome: { executor_id: string; logs: string[]; status: unknown; receipt_ids: string[] };
}

export interface TxRecord {
  transaction: { hash: string; signer_id: string; receiver_id: string };
  execution_outcome: TxOutcome;
  receipts: Array<{ receipt: { receipt_id: string; receiver_id: string; predecessor_id: string }; execution_outcome: TxOutcome }>;
}

/** Block times are nanosecond integers past what a JSON number keeps exactly: read them as strings. */
export function parseApiJson<T>(text: string): T {
  return JSON.parse(text.replace(/"block_timestamp":\s*(\d+)/g, '"block_timestamp":"$1"')) as T;
}

export class TxApi {
  private last = 0;
  requests = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly key?: string,
    private readonly minIntervalMs = 1100,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = this.last + (this.key ? 50 : this.minIntervalMs) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      this.requests++;
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new Error(`tx api ${path} answered ${res.status}: ${await res.text()}`);
        return parseApiJson<T>(await res.text());
      } catch (e) {
        if (attempt === 5) throw e;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw new Error(`tx api ${path} kept failing`);
  }

  async head(): Promise<number> {
    const r = await this.post<{ blocks: Array<{ block_height: number }> }>('/v0/blocks', { limit: 1, desc: true });
    return r.blocks[0]?.block_height ?? 0;
  }

  /** Every transaction that touched `account` between `from` and `to` (inclusive), oldest first. */
  async accountTxs(account: string, from: number, to: number): Promise<Array<{ hash: string; height: number }>> {
    const out: Array<{ hash: string; height: number }> = [];
    let resume: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.post<{ account_txs: Array<{ transaction_hash: string; tx_block_height: number }>; resume_token?: string }>('/v0/account', {
        account_id: account,
        from_tx_block_height: from,
        to_tx_block_height: to,
        desc: false,
        limit: 200,
        ...(resume ? { resume_token: resume } : {}),
      });
      out.push(...r.account_txs.map((t) => ({ hash: t.transaction_hash, height: t.tx_block_height })));
      if (!r.resume_token || r.account_txs.length === 0) break;
      resume = r.resume_token;
    }
    return out;
  }

  async transactions(hashes: string[]): Promise<TxRecord[]> {
    const out: TxRecord[] = [];
    for (let i = 0; i < hashes.length; i += 20) {
      const r = await this.post<{ transactions: TxRecord[] }>('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) });
      out.push(...r.transactions);
    }
    return out;
  }
}

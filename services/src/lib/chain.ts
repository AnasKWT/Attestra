/**
 * The chain as the services see it: reads (views, balances, head) that work with no key, and
 * writes that go through a send queue so one key never signs two transactions at once.
 * Tests replace both with fakes.
 */

import { AttestraClient, errorMessage } from 'attestra';
import { Near, type PrivateKey, type SignedDelegateAction, type TransactionBuilder } from 'near-kit';
import type { ServiceConfig } from './config';
import { successValue, txHashOf } from './outcome';
import { LanePool } from './queue';
import { TGAS } from './units';

export interface TxResult {
  txHash: string;
  value: unknown;
  /** The final outcome, for receipt logs (fakes may leave it out). */
  outcome?: unknown;
}

export interface ChainReader {
  view<T>(contract: string, method: string, args?: object): Promise<T>;
  /** Account balance (the RPC `amount`) in yoctoNEAR; null when the account does not exist. */
  balance(accountId: string): Promise<bigint | null>;
  /** True when `publicKey` is an access key of `accountId`. */
  hasKey(accountId: string, publicKey: string): Promise<boolean>;
  /** True when `publicKey` is a full-access key of `accountId` (final). */
  fullAccessKey?(accountId: string, publicKey: string): Promise<boolean>;
}

export interface ChainWriter {
  readonly accountId: string;
  call(contract: string, method: string, args: object, opts?: { deposit?: bigint; gas?: bigint }): Promise<TxResult>;
  transfer(receiver: string, amount: bigint): Promise<TxResult>;
  /** Submits a NEP-366 signed delegate action, paying its gas. */
  relay(signed: SignedDelegateAction): Promise<TxResult>;
  /** Transactions waiting or in flight. */
  queueLength(): number;
  /** Parallel nonce lanes (1 without a gas key). */
  readonly lanes: number;
  readonly gasKey: boolean;
}

export class RpcReader implements ChainReader {
  readonly client: AttestraClient;

  constructor(cfg: Pick<ServiceConfig, 'network' | 'root' | 'rpcUrl'>) {
    this.client = new AttestraClient({ network: cfg.network, root: cfg.root, rpcUrl: cfg.rpcUrl });
  }

  view<T>(contract: string, method: string, args: object = {}): Promise<T> {
    return this.client.view<T>(contract, method, args);
  }

  async balance(accountId: string): Promise<bigint | null> {
    try {
      const a = await this.client.rpc<{ amount: string }>('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
      return BigInt(a.amount);
    } catch (e) {
      if (/UNKNOWN_ACCOUNT|does not exist/i.test(errorMessage(e))) return null;
      throw e;
    }
  }

  async fullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    try {
      const k = await this.client.rpc<{ permission?: unknown }>('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
      return k.permission === 'FullAccess';
    } catch (e) {
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(errorMessage(e))) return false;
      throw e;
    }
  }

  async hasKey(accountId: string, publicKey: string): Promise<boolean> {
    try {
      await this.client.rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
      return true;
    } catch (e) {
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(errorMessage(e))) return false;
      throw e;
    }
  }
}

export interface WriterOptions {
  accountId: string;
  privateKey: string;
  network: ServiceConfig['network'];
  rpcUrl: string;
  /** Gas key secret and its lane count; without them every write goes through one queue. */
  gasKey?: string;
  gasKeyLanes?: number;
}

export class NearWriter implements ChainWriter {
  readonly accountId: string;
  readonly lanes: number;
  readonly gasKey: boolean;
  private readonly near: Near;
  private readonly pool: LanePool;
  private readonly gasKeySecret?: PrivateKey;

  constructor(o: WriterOptions) {
    this.accountId = o.accountId;
    this.near = new Near({
      network: o.network,
      rpcUrl: o.rpcUrl,
      privateKey: o.privateKey as PrivateKey,
      defaultSignerId: o.accountId,
      retryConfig: { maxRetries: 2, initialDelayMs: 400 },
    });
    this.gasKey = Boolean(o.gasKey && (o.gasKeyLanes ?? 0) > 0);
    this.gasKeySecret = this.gasKey ? (o.gasKey as PrivateKey) : undefined;
    this.lanes = this.gasKey ? (o.gasKeyLanes as number) : 1;
    this.pool = new LanePool(this.lanes);
  }

  queueLength(): number {
    return this.pool.length;
  }

  private async send(build: (tx: TransactionBuilder) => TransactionBuilder): Promise<TxResult> {
    return this.pool.run(async (lane) => {
      let tx = this.near.transaction(this.accountId);
      if (this.gasKeySecret) tx = tx.signWith(this.gasKeySecret).useGasKey(lane);
      const outcome = await build(tx).send({ waitUntil: 'EXECUTED_OPTIMISTIC' });
      return { txHash: txHashOf(outcome), value: successValue(outcome), outcome };
    });
  }

  call(contract: string, method: string, args: object, opts: { deposit?: bigint; gas?: bigint } = {}): Promise<TxResult> {
    const gas = opts.gas ?? 100n * TGAS;
    return this.send((tx) => tx.functionCall(contract, method, args, { gas: `${Number(gas / TGAS)} Tgas`, attachedDeposit: `${opts.deposit ?? 0n} yocto` }));
  }

  transfer(receiver: string, amount: bigint): Promise<TxResult> {
    return this.send((tx) => tx.transfer(receiver, `${amount} yocto`));
  }

  relay(signed: SignedDelegateAction): Promise<TxResult> {
    return this.send((tx) => tx.signedDelegateAction(signed));
  }
}

/** Resolves within `ms` or rejects, so `/health` stays fast when the RPC is slow. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * CHECKER_MODE=outlayer: the private check runs in the checker/ component inside an OutLayer TEE
 * instead of in this process.
 *
 * The checker signs with an OutLayer signing key declared `bind: "wasm"`, `caller: "none"`: the
 * keystore derives it from the sha256 of the exact build, so a new build has a new key and nobody
 * (Attestra included) can make another program sign with it. OutLayer issues such a key only to a
 * direct run of a published wasm URL, and a direct run is started on chain: this module calls
 * `request_execution` on the OutLayer contract with a `WasmUrl` source, and the transaction's
 * return value is the checker's JSON output (NEAR yield and resume). The HTTPS API runs projects
 * only, whose keys belong to the project and survive code upgrades, so it is not used here.
 *
 * The caller's secrets (NEARAI_API_KEY, optionally GITHUB_TOKEN) come from a secrets row the agent
 * account stored for this wasm hash (`outlayer secrets set ... --wasm-hash <sha256>`).
 */

import { base58Decode, base64ToBytes, verdictDigest, type AiVerdict } from '@attestra/sdk';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { CheckOutput } from './check';

/** The run's limits; the contract's caps are 500B instructions and 180 seconds. */
export const OUTLAYER_LIMITS = { max_instructions: 2_000_000_000, max_memory_mb: 128, max_execution_seconds: 120 } as const;
export const OUTLAYER_GAS = 300n * 10n ** 12n;
/** How long to wait for the yielded transaction to resume (the contract's yield lasts about 200 blocks). */
export const OUTLAYER_WAIT_MS = 300_000;

export interface OutLayerConfig {
  /** The OutLayer contract (`outlayer.testnet`, `outlayer.near`). */
  contract: string;
  /** Where the published checker wasm is served (FastFS or any https URL). */
  wasmUrl: string;
  /** Its sha256 (hex): the worker refuses other bytes, and the signing key is bound to it. */
  wasmHash: string;
  /** The secrets row the run reads: its owner (the agent account) and profile. */
  secretsOwner: string;
  secretsProfile: string;
}

/** The checker's stdin (checker/src/check.rs `CheckInput`). */
export interface CheckerRequest {
  operation: 'check';
  request_id: string;
  rule_id: string;
  subject: string;
  model: string;
  encrypted_evidence: string;
  github: string | null;
}

/** The chain operations the transport needs, so tests can stand in for NEAR. */
export interface OutLayerChain {
  view<T>(contractId: string, method: string, args: object): Promise<T>;
  /** Sends a function call and resolves with its decoded return value once it executed. */
  call(contractId: string, method: string, args: object, opts: { deposit: bigint; gas: bigint }): Promise<unknown>;
}

export function checkerRequest(p: { requestId: string; ruleId: string; subject: string; model: string; encryptedEvidence: string; github?: string | null }): CheckerRequest {
  return {
    operation: 'check',
    request_id: p.requestId,
    rule_id: p.ruleId,
    subject: p.subject,
    model: p.model,
    encrypted_evidence: p.encryptedEvidence,
    github: p.github ?? null,
  };
}

/** The `request_execution` arguments for one check. */
export function requestExecutionArgs(cfg: OutLayerConfig, request: CheckerRequest) {
  if (!/^[0-9a-f]{64}$/.test(cfg.wasmHash)) throw new Error('OUTLAYER_WASM_HASH must be 64 lowercase hex characters');
  if (!/^https:\/\//.test(cfg.wasmUrl)) throw new Error('OUTLAYER_WASM_URL must be an https URL');
  return {
    source: { WasmUrl: { url: cfg.wasmUrl, hash: cfg.wasmHash, build_target: 'wasm32-wasip2' } },
    resource_limits: { ...OUTLAYER_LIMITS },
    input_data: JSON.stringify(request),
    secrets_ref: { profile: cfg.secretsProfile, account_id: cfg.secretsOwner },
    response_format: 'Json',
  };
}

/** Checks what the TEE answered before the agent spends a transaction on it. */
export function checkCheckerOutput(request: CheckerRequest, value: unknown): CheckOutput {
  const out = (typeof value === 'string' ? JSON.parse(value) : value) as (CheckOutput & { error?: string }) | null | undefined;
  if (out === null || out === undefined) throw new Error('the OutLayer run produced no output (it failed or timed out)');
  if (typeof out.error === 'string') throw new Error(`the checker refused: ${out.error}`);
  const v = out.verdict as AiVerdict | undefined;
  if (!v || !out.enclaveKey || !out.enclaveSignature || !out.nearai) throw new Error('the checker answered an unexpected shape');
  if (v.request_id !== request.request_id || v.rule_id !== request.rule_id || v.subject !== request.subject || v.model !== request.model) {
    throw new Error('the checker signed a verdict for another request');
  }
  if (!out.enclaveKey.startsWith('ed25519:')) throw new Error('the checker key must be ed25519');
  if (!ed25519.verify(base64ToBytes(out.enclaveSignature), verdictDigest(v), base58Decode(out.enclaveKey.slice(8)))) {
    throw new Error('the checker signature does not verify');
  }
  return out;
}

/** Runs one check in the OutLayer TEE and returns the checker's verified output. */
export async function runCheckOnOutLayer(chain: OutLayerChain, cfg: OutLayerConfig, request: CheckerRequest): Promise<CheckOutput> {
  const args = requestExecutionArgs(cfg, request);
  const cost = await chain.view<string>(cfg.contract, 'estimate_execution_cost', {
    resource_limits: args.resource_limits,
    input_len: new TextEncoder().encode(args.input_data).length,
  });
  const value = await chain.call(cfg.contract, 'request_execution', args, { deposit: BigInt(cost), gas: OUTLAYER_GAS });
  return checkCheckerOutput(request, value);
}

/** A function call's return value from a final execution outcome. */
export function decodeReturnValue(outcome: unknown): unknown {
  const status = (outcome as { status?: { SuccessValue?: string; Failure?: unknown } } | undefined)?.status;
  if (status && typeof status === 'object' && 'Failure' in status && status.Failure) throw new Error(`the OutLayer call failed: ${JSON.stringify(status.Failure)}`);
  const v = status?.SuccessValue;
  if (!v) return null;
  const text = new TextDecoder().decode(base64ToBytes(v));
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Minimal near-kit surface the chain adapter uses. */
interface NearLike {
  view<T>(contractId: string, method: string, args: object): Promise<T | undefined>;
  call(contractId: string, method: string, args: object, options: object): Promise<unknown>;
  getTransactionStatus(txHash: string, senderAccountId: string, waitUntil?: string): Promise<unknown>;
}

/**
 * `OutLayerChain` over near-kit. `request_execution` yields until the worker resolves the run, which
 * can outlast the RPC's wait: on a timeout the transaction is followed by its hash until it executed.
 */
export function nearChain(near: NearLike, signerId: string, opts: { waitMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): OutLayerChain {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  return {
    async view<T>(contractId: string, method: string, args: object) {
      const value = await near.view<T>(contractId, method, args);
      if (value === undefined) throw new Error(`${contractId}.${method} returned nothing`);
      return value;
    },
    async call(contractId, method, args, { deposit, gas }) {
      const deadline = now() + (opts.waitMs ?? OUTLAYER_WAIT_MS);
      let txHash: string | undefined;
      try {
        return decodeReturnValue(
          await near.call(contractId, method, args, { signerId, gas: `${gas / 10n ** 12n} Tgas`, attachedDeposit: `${deposit} yocto`, waitUntil: 'EXECUTED_OPTIMISTIC' }),
        );
      } catch (e) {
        txHash = (e as { name?: string; transactionHash?: string }).name === 'TimeoutError' ? (e as { transactionHash?: string }).transactionHash : undefined;
        if (!txHash) throw e;
      }
      for (;;) {
        try {
          return decodeReturnValue(await near.getTransactionStatus(txHash, signerId, 'EXECUTED_OPTIMISTIC'));
        } catch (e) {
          if ((e as { name?: string }).name !== 'TimeoutError' || now() > deadline) throw e;
        }
        await sleep(2_000);
      }
    },
  };
}

import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { base58Encode, bytesToBase64, verdictDigest, type AiVerdict, type AttestraClient } from '@attestra/sdk';
import type { Near } from 'near-kit';
import { createApp, outlayerSettings } from '../src/app';
import { loadConfig } from '../src/config';
import { NearAi } from '../src/nearai';
import { checkCheckerOutput, checkerRequest, decodeReturnValue, nearChain, OUTLAYER_DEPOSIT_MARGIN, OUTLAYER_GAS, requestExecutionArgs, runCheckOnOutLayer, type CheckerRequest, type OutLayerChain, type OutLayerConfig } from '../src/outlayer';

const HASH = 'ab'.repeat(32);
const cfg: OutLayerConfig = {
  contract: 'outlayer.testnet',
  wasmUrl: `https://test.fastfs.io/agent.attestra.testnet/outlayer.testnet/${HASH}.wasm`,
  wasmHash: HASH,
  secretsOwner: 'agent.attestra.testnet',
  secretsProfile: 'checker',
};
const enclaveSeed = new Uint8Array(32).fill(5);
const enclaveKey = `ed25519:${base58Encode(ed25519.getPublicKey(enclaveSeed))}`;

const request = checkerRequest({ requestId: '1f'.repeat(32), ruleId: 'age_over_18', subject: 'bob.testnet', model: 'z-ai/glm-5.3-flash', encryptedEvidence: 'beef', github: undefined });

/** What the checker prints for `request`, signed with the test enclave key. */
function checkerOutput(req = request, overrides: Partial<AiVerdict> = {}) {
  const verdict: AiVerdict = {
    request_id: req.request_id,
    rule_id: req.rule_id,
    subject: req.subject,
    result: true,
    evidence_hash: 'cd'.repeat(32),
    model: req.model,
    issued_at: 1_790_000_000,
    expires_at: 1_790_000_000 + 365 * 86_400,
    ...overrides,
  };
  return {
    verdict,
    enclaveKey,
    enclaveSignature: bytesToBase64(ed25519.sign(verdictDigest(verdict), enclaveSeed)),
    nearai: { text: `${req.model}:${'cd'.repeat(32)}:${'ef'.repeat(32)}`, signature: '00'.repeat(64), algo: 'ed25519' as const, key: '11'.repeat(32) },
    answer: 'PASS',
  };
}

function fakeChain(answer: (input: CheckerRequest) => unknown) {
  const calls: Array<{ contractId: string; method: string; args: Record<string, unknown>; deposit?: bigint; gas?: bigint }> = [];
  const chain: OutLayerChain = {
    async view<T>(contractId: string, method: string, args: object) {
      calls.push({ contractId, method, args: args as Record<string, unknown> });
      return '250000000000000000000000' as T;
    },
    async call(contractId, method, args, { deposit, gas }) {
      calls.push({ contractId, method, args: args as Record<string, unknown>, deposit, gas });
      return answer(JSON.parse((args as { input_data: string }).input_data));
    },
  };
  return { chain, calls };
}

describe('OutLayer checker requests', () => {
  it('builds request_execution for a direct, build-bound run of the published wasm', () => {
    expect(request).toEqual({ operation: 'check', request_id: '1f'.repeat(32), rule_id: 'age_over_18', subject: 'bob.testnet', model: 'z-ai/glm-5.3-flash', encrypted_evidence: 'beef', github: null });
    expect(requestExecutionArgs(cfg, request)).toEqual({
      source: { WasmUrl: { url: cfg.wasmUrl, hash: HASH, build_target: 'wasm32-wasip2' } },
      resource_limits: { max_instructions: 2_000_000_000, max_memory_mb: 128, max_execution_seconds: 120 },
      input_data: JSON.stringify(request),
      secrets_ref: { profile: 'checker', account_id: 'agent.attestra.testnet' },
      response_format: 'Json',
    });
    expect(() => requestExecutionArgs({ ...cfg, wasmHash: 'AB' }, request)).toThrow(/OUTLAYER_WASM_HASH/);
    expect(() => requestExecutionArgs({ ...cfg, wasmUrl: 'http://x/y.wasm' }, request)).toThrow(/https/);
  });

  it('pays the estimated cost plus room for a large output, sends the check and verifies what the TEE signed', async () => {
    const { chain, calls } = fakeChain((input) => checkerOutput(input));
    const out = await runCheckOnOutLayer(chain, cfg, request);
    expect(out.verdict.request_id).toBe(request.request_id);
    expect(calls[0]).toEqual({
      contractId: 'outlayer.testnet',
      method: 'estimate_execution_cost',
      args: { resource_limits: requestExecutionArgs(cfg, request).resource_limits, input_len: new TextEncoder().encode(JSON.stringify(request)).length },
    });
    expect(calls[1]).toMatchObject({ contractId: 'outlayer.testnet', method: 'request_execution', deposit: 250000000000000000000000n + OUTLAYER_DEPOSIT_MARGIN, gas: OUTLAYER_GAS });
    expect(calls[1].args).toEqual(requestExecutionArgs(cfg, request));
  });

  it('refuses failed runs, refusals, other requests and bad signatures', async () => {
    await expect(runCheckOnOutLayer(fakeChain(() => null).chain, cfg, request)).rejects.toThrow(/no output/);
    await expect(runCheckOnOutLayer(fakeChain(() => ({ error: 'unknown or disabled rule x' })).chain, cfg, request)).rejects.toThrow('the checker refused: unknown or disabled rule x');
    expect(() => checkCheckerOutput(request, checkerOutput(request, { request_id: '2f'.repeat(32) }))).toThrow(/another request/);
    expect(() => checkCheckerOutput(request, checkerOutput(request, { subject: 'eve.testnet' }))).toThrow(/another request/);
    const forged = { ...checkerOutput(), verdict: { ...checkerOutput().verdict, result: false } };
    expect(() => checkCheckerOutput(request, forged)).toThrow(/does not verify/);
    expect(() => checkCheckerOutput(request, { answer: 'PASS' })).toThrow(/unexpected shape/);
    expect(checkCheckerOutput(request, JSON.stringify(checkerOutput())).answer).toBe('PASS');
  });

  it('follows a yielded transaction past an RPC timeout and decodes its return value', async () => {
    const value = Buffer.from(JSON.stringify(checkerOutput())).toString('base64');
    const seen: string[] = [];
    let polls = 0;
    type NearLike = Parameters<typeof nearChain>[0];
    const near = {
      async view() {
        return '1';
      },
      async call(_c: string, _m: string, _a: object, options: object) {
        seen.push(JSON.stringify(options));
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError', transactionHash: 'TxHash1' });
      },
      async getTransactionStatus(txHash: string, sender: string, waitUntil?: string) {
        seen.push(`${txHash} ${sender} ${waitUntil}`);
        if (++polls < 3) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        return { status: { SuccessValue: value } };
      },
    };
    const chain = nearChain(near as unknown as NearLike, 'agent.attestra.testnet', { sleep: async () => {} });
    const out = (await chain.call('outlayer.testnet', 'request_execution', {}, { deposit: 7n, gas: OUTLAYER_GAS })) as ReturnType<typeof checkerOutput>;
    expect(out.verdict.request_id).toBe(request.request_id);
    expect(JSON.parse(seen[0])).toEqual({ signerId: 'agent.attestra.testnet', gas: '300 Tgas', attachedDeposit: '7 yocto', waitUntil: 'EXECUTED_OPTIMISTIC' });
    expect(seen.slice(1)).toEqual(Array(3).fill('TxHash1 agent.attestra.testnet EXECUTED_OPTIMISTIC'));

    let clock = 0;
    const stuck = nearChain({ ...near, getTransactionStatus: async () => Promise.reject(Object.assign(new Error('still waiting'), { name: 'TimeoutError' })) } as unknown as NearLike, 'a', { sleep: async () => void (clock += 2_000), now: () => clock, waitMs: 5_000 });
    await expect(stuck.call('o', 'm', {}, { deposit: 0n, gas: 0n })).rejects.toThrow('still waiting');

    expect(decodeReturnValue({ status: { SuccessValue: '' } })).toBeNull();
    expect(() => decodeReturnValue({ status: { Failure: { ActionError: {} } } })).toThrow(/failed/);
  });
});

describe('agent in outlayer mode', () => {
  const env = { CHECKER_MODE: 'outlayer', OUTLAYER_WASM_URL: cfg.wasmUrl, OUTLAYER_WASM_HASH: HASH.toUpperCase(), OUTLAYER_SECRETS_PROFILE: 'checker', AGENT_ACCOUNT_ID: 'agent.attestra.testnet' };

  it('reads its settings and refuses an unknown mode', () => {
    expect(outlayerSettings(loadConfig(env))).toEqual(cfg);
    expect(outlayerSettings(loadConfig({ CHECKER_MODE: 'outlayer' }))).toMatch(/OUTLAYER_WASM_URL/);
    expect(loadConfig({}).checkerMode).toBe('local');
    expect(() => loadConfig({ CHECKER_MODE: 'tee' })).toThrow(/local or outlayer/);
  });

  it('sends the check to OutLayer and submits the verdict it signed', async () => {
    const config = { ...loadConfig(env), nearAiKey: 'k' };
    const models = (async () => Response.json({ models: [{ modelId: 'z-ai/glm-5.3-flash', metadata: { verifiable: true } }] })) as unknown as typeof fetch;
    const submitted: Array<{ method: string; args: Record<string, unknown> }> = [];
    const client = {
      contracts: { verdicts: 'verdicts.attestra.testnet' },
      async view() {
        return [{ id: 'age_over_18', claim: 'is at least 18 years old', enabled: true }];
      },
      async callRaw(_c: string, method: string, args: Record<string, unknown>) {
        submitted.push({ method, args });
        return { value: { uid: 'u', status: 'attested' }, txHash: 'Tx2' };
      },
    } as unknown as AttestraClient;
    const { chain, calls } = fakeChain((input) => checkerOutput(input));
    const app = createApp({ config, ai: new NearAi('k', models), client, near: {} as Near, startedAt: Date.now(), outlayer: chain });

    const health = (await (await app.request('/health')).json()) as { checker: unknown; reason?: string };
    expect(health.checker).toEqual({ mode: 'outlayer', wasm_hash: HASH });
    expect(health.reason ?? '').not.toMatch(/CHECKER_PRIVATE_KEY|OUTLAYER/);

    const res = await app.request('/v1/check', { method: 'POST', body: JSON.stringify({ rule_id: 'age_over_18', subject: 'bob.testnet', encrypted_evidence: 'beef' }) });
    expect(res.status).toBe(200);
    const sent = JSON.parse(calls[1].args.input_data as string) as typeof request;
    expect(sent).toMatchObject({ operation: 'check', rule_id: 'age_over_18', subject: 'bob.testnet', model: 'z-ai/glm-5.3-flash', encrypted_evidence: 'beef', github: null });
    expect(sent.request_id).toMatch(/^[0-9a-f]{64}$/);
    const out = checkerOutput(sent);
    expect(submitted).toEqual([{ method: 'submit_ai_verdict', args: { verdict: out.verdict, enclave_key: out.enclaveKey, enclave_signature: out.enclaveSignature, nearai: out.nearai } }]);
    expect(((await res.json()) as { tx_hash: string }).tx_hash).toBe('Tx2');
  });

  it('says why checks are off when the wasm is not configured', async () => {
    const config = { ...loadConfig({ CHECKER_MODE: 'outlayer' }), nearAiKey: 'k' };
    const app = createApp({ config, ai: new NearAi('k'), client: {} as AttestraClient, near: {} as Near, startedAt: Date.now() });
    const h = (await (await app.request('/health')).json()) as { reason: string };
    expect(h.reason).toMatch(/OUTLAYER_WASM_URL and OUTLAYER_WASM_HASH are not set/);
    expect((await app.request('/v1/check', { method: 'POST', body: '{}' })).status).toBe(503);
  });
});

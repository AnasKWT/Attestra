import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, VerificationError, type AttestationVerificationResult, type CompletionSignature, type VerifiedModelAttestation } from '@nearai/inference-sdk/node';
import { DEFAULT_CONTRACT, nodeSupported, parseCli, render, UsageError } from '../src/cli.js';
import { readTrustedSigners } from '../src/contract.js';
import { attestModel, bindsKey, fetchSignature, probe, retryable, verifyChat, type ChatProbe, type SignatureSource } from '../src/verify.js';

const MODEL = 'z-ai/glm-5.3-flash';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');
  return { pub, signText: (text: string) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('hex') };
}

function modelAttestation(key: string, over: Partial<{ gpu: 'verified' | 'not_provided'; tcb: string }> = {}): VerifiedModelAttestation {
  return {
    signer: { signingAlgo: 'ed25519', signingAddress: key },
    signingPublicKey: key,
    tcbStatus: over.tcb ?? 'UpToDate',
    advisoryIds: [],
    deployment: { appCompose: '{}', runtimeMeasurements: { osImageHash: 'aa', composeHash: 'bb' } },
    deploymentProvenance: 'not_checked',
    gpuEvidence: over.gpu ?? 'verified',
    report: {},
  } as unknown as VerifiedModelAttestation;
}

function result(models: VerifiedModelAttestation[]): AttestationVerificationResult {
  return {
    gateway: {
      signer: { signingAlgo: 'ed25519', signingAddress: '11'.repeat(32) },
      tcbStatus: 'UpToDate',
      advisoryIds: [],
      deployment: { appCompose: '{}', runtimeMeasurements: {} },
      deploymentProvenance: 'not_checked',
      tlsBinding: { kind: 'attested', spkiFingerprint: 'ab'.repeat(32) },
      report: {},
    },
    models,
    verifiedAt: 0,
  } as unknown as AttestationVerificationResult;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A signed chat as NEAR AI returns it: the model's key over `{model}:{sha256(request)}:{sha256(response)}`. */
function signedChat(signerKey = keypair(), over: Partial<CompletionSignature> = {}) {
  const requestBody = Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }));
  const responseBody = Buffer.from(JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  const signedText = `${MODEL}:${sha(requestBody)}:${sha(responseBody)}`;
  const signature: CompletionSignature = { kind: 'provider_tee', signer: { signingAlgo: 'ed25519', signingAddress: signerKey.pub }, signedText, signature: signerKey.signText(signedText), ...over };
  const source: SignatureSource = { fetchCompletionSignature: vi.fn(async () => signature) };
  return { key: signerKey, requestBody, responseBody, signature, source };
}

describe('parseCli', () => {
  it('defaults to the testnet verdicts contract', () => {
    const o = parseCli([]);
    expect(o).toMatchObject({ contract: DEFAULT_CONTRACT, algo: 'ed25519', gpu: 'required', probe: false, json: false });
  });

  it('takes an explicit key instead of the contract', () => {
    const o = parseCli(['--model', MODEL, '--expect-key', `0x${'Ab'.repeat(32)}`, '--json']);
    expect(o.contract).toBeUndefined();
    expect(o.expectKey).toBe(`0x${'Ab'.repeat(32)}`);
    expect(o.json).toBe(true);
  });

  it('refuses a chat id without the exact bodies, and other bad combinations', () => {
    expect(() => parseCli(['--chat-id', 'chatcmpl-1'])).toThrow(/exact request and response bytes/);
    expect(() => parseCli(['--expect-key', 'aa'.repeat(32)])).toThrow(/needs --model/);
    expect(() => parseCli(['--model', MODEL, '--expect-key', 'zz'])).toThrow(UsageError);
    expect(() => parseCli(['--algo', 'rsa'])).toThrow(/ed25519 or ecdsa/);
    expect(() => parseCli(['--gpu', 'never'])).toThrow(/required or if-present/);
    expect(() => parseCli(['--no-contract'])).toThrow(/needs --model/);
    expect(() => parseCli(['--bogus'])).toThrow(UsageError);
  });

  it('keeps the three chat parts together', () => {
    const o = parseCli(['--chat-id', 'c1', '--request-file', 'req.json', '--response-file', 'res.json']);
    expect(o.chat).toEqual({ id: 'c1', requestFile: 'req.json', responseFile: 'res.json' });
  });
});

describe('nodeSupported', () => {
  it('follows the SDK engines field (>= 24.22.1)', () => {
    expect(['24.22.1', 'v24.22.2', '24.23.0', '25.0.0'].map(nodeSupported)).toEqual([true, true, true, true]);
    expect(['24.22.0', '24.9.9', '22.22.1', 'v20.19.4'].map(nodeSupported)).toEqual([false, false, false, false]);
  });
});

describe('readTrustedSigners', () => {
  const rpc = (config: unknown) =>
    vi.fn(async () => new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(config))] } }))) as unknown as typeof fetch;

  it('reads model_signers from get_config', async () => {
    const f = rpc({ model_signers: [{ model: MODEL, algo: 'ed25519', key: '5a'.repeat(32) }] });
    expect(await readTrustedSigners('https://rpc', 'verdicts.x.testnet', f)).toEqual([{ model: MODEL, algo: 'ed25519', key: '5a'.repeat(32) }]);
    const body = JSON.parse((vi.mocked(f).mock.calls[0][1] as RequestInit).body as string);
    expect(body.params).toMatchObject({ account_id: 'verdicts.x.testnet', method_name: 'get_config', finality: 'final' });
  });

  it('rejects a malformed signer and reports RPC errors', async () => {
    await expect(readTrustedSigners('https://rpc', 'v', rpc({ model_signers: [{ model: MODEL, algo: 'rsa', key: 'k' }] }))).rejects.toThrow(/malformed/);
    const err = vi.fn(async () => new Response(JSON.stringify({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }))) as unknown as typeof fetch;
    await expect(readTrustedSigners('https://rpc', 'v', err)).rejects.toThrow(/UNKNOWN_ACCOUNT/);
  });
});

describe('attestModel', () => {
  it('passes when an attested report binds the trusted key', async () => {
    const key = '5a'.repeat(32);
    const { report, models } = await attestModel({ verify: async () => result([modelAttestation(key)]) }, MODEL, { key: `0x${key.toUpperCase()}`, algo: 'ed25519' });
    expect(report.ok).toBe(true);
    expect(report.trusted).toEqual({ key, attested: true });
    expect(report.signers[0]).toMatchObject({ key, gpuEvidence: 'verified', tcbStatus: 'UpToDate', composeHash: 'bb' });
    expect(report.gateway?.tlsBinding).toMatch(/^attested/);
    expect(models).toHaveLength(1);
  });

  it('fails when the trusted key is not attested', async () => {
    const { report } = await attestModel({ verify: async () => result([modelAttestation('77'.repeat(32))]) }, MODEL, { key: '5a'.repeat(32) });
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe('trust.key_not_attested');
  });

  it('fails for a Gateway-only model', async () => {
    const { report } = await attestModel({ verify: async () => result([]) }, MODEL);
    expect(report).toMatchObject({ ok: false, error: { code: 'model.not_attested' } });
  });

  it('carries the SDK failure code when verification rejects', async () => {
    const verify = async () => {
      throw new VerificationError({ code: 'policy.gpu_evidence_required' });
    };
    const { report } = await attestModel({ verify }, MODEL, { key: '5a'.repeat(32) });
    expect(report).toMatchObject({ ok: false, error: { code: 'policy.gpu_evidence_required' } });
  });

  it('matches keys by algorithm', () => {
    const s = [{ algo: 'ecdsa' as const, key: '5a'.repeat(32), tcbStatus: 'UpToDate', advisoryIds: [], gpuEvidence: 'verified' as const }];
    expect(bindsKey(s, '5a'.repeat(32), 'ed25519')).toBe(false);
    expect(bindsKey(s, '5A'.repeat(32))).toBe(true);
  });
});

describe('verifyChat (the SDK checks the exact bytes and the signature)', () => {
  it('verifies a provider_tee signature by an attested, trusted signer', async () => {
    const c = signedChat();
    const r = await verifyChat({ ...c, chatId: 'chatcmpl-1', attestations: [modelAttestation(c.key.pub)], algo: 'ed25519', trustedKey: c.key.pub });
    expect(r).toMatchObject({ ok: true, kind: 'provider_tee', signer: c.key.pub, trusted: true });
    expect(c.source.fetchCompletionSignature).toHaveBeenCalledWith({ completionId: 'chatcmpl-1', signingAlgo: 'ed25519' });
  });

  it('rejects bytes that differ from the signed hashes', async () => {
    const c = signedChat();
    const r = await verifyChat({ ...c, responseBody: Buffer.from('{"tampered":true}'), chatId: 'c', attestations: [modelAttestation(c.key.pub)], algo: 'ed25519' });
    expect(r).toMatchObject({ ok: false, error: { code: 'signature.payload_mismatch' } });
  });

  it('rejects a signature that does not verify', async () => {
    const c = signedChat(keypair(), {});
    const forged = { ...c.signature, signature: keypair().signText(c.signature.signedText) };
    const source: SignatureSource = { fetchCompletionSignature: async () => forged };
    const r = await verifyChat({ ...c, source, chatId: 'c', attestations: [modelAttestation(c.key.pub)], algo: 'ed25519' });
    expect(r).toMatchObject({ ok: false, error: { code: 'signature.invalid' } });
  });

  it('rejects a signer no verified report binds, a Gateway signature, and an untrusted signer', async () => {
    const c = signedChat();
    const notAttested = await verifyChat({ ...c, chatId: 'c', attestations: [modelAttestation('77'.repeat(32))], algo: 'ed25519' });
    expect(notAttested.error?.code).toBe('api.model_attestation_signer_not_found');

    const g = signedChat(keypair(), { kind: 'gateway' });
    const gateway = await verifyChat({ ...g, chatId: 'c', attestations: [modelAttestation(g.key.pub)], algo: 'ed25519' });
    expect(gateway.error?.code).toBe('signature.kind_mismatch');

    const untrusted = await verifyChat({ ...c, chatId: 'c', attestations: [modelAttestation(c.key.pub)], algo: 'ed25519', trustedKey: '5a'.repeat(32) });
    expect(untrusted).toMatchObject({ ok: false, trusted: false, error: { code: 'trust.signer_not_trusted' } });
  });
});

describe('fetchSignature', () => {
  it('retries while the signature is not there yet, then gives up on other failures', async () => {
    const c = signedChat();
    const unavailable = new ApiError({ code: 'api.completion_signature_unavailable', details: { providerErrorCode: 'not_found', providerMessage: 'not yet' } });
    const fetchCompletionSignature = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValueOnce(c.signature);
    expect(await fetchSignature({ fetchCompletionSignature }, 'c', 'ed25519', 3, 1)).toBe(c.signature);
    expect(fetchCompletionSignature).toHaveBeenCalledTimes(2);

    const bad = new ApiError({ code: 'api.invalid_json', details: { resource: 'completion_signature' } });
    const failing = vi.fn().mockRejectedValue(bad);
    await expect(fetchSignature({ fetchCompletionSignature: failing }, 'c', 'ed25519', 3, 1)).rejects.toBe(bad);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('treats a 404 and SDK-retryable failures as retryable', () => {
    expect(retryable(new ApiError({ code: 'api.http_status', details: { resource: 'completion_signature', status: 404 }, retryable: false }))).toBe(true);
    expect(retryable(new ApiError({ code: 'api.http_status', details: { resource: 'completion_signature', status: 401 }, retryable: false }))).toBe(false);
    expect(retryable(new ApiError({ code: 'api.transport_failed', details: { resource: 'completion_signature', reason: 'request' }, retryable: true }))).toBe(true);
    expect(retryable(new Error('plain'))).toBe(false);
  });
});

describe('probe', () => {
  const client = (kind: 'provider_tee' | 'gateway', signer: string): ChatProbe => ({
    chat: { completions: { create: vi.fn(async () => ({ id: 'chatcmpl-9' })) } },
    verifyResponse: vi.fn(async (id: string) => ({ id, completionId: id, signatureKind: kind, signature: { kind, signer: { signingAlgo: 'ed25519', signingAddress: signer }, signedText: 't', signature: 's' }, attestations: [], attestation: {} }) as never),
  });

  it('accepts a model-signed response from the trusted key', async () => {
    const c = client('provider_tee', '5a'.repeat(32));
    expect(await probe(c, MODEL, '5a'.repeat(32))).toMatchObject({ ok: true, chatId: 'chatcmpl-9', trusted: true });
    expect(c.verifyResponse).toHaveBeenCalledWith('chatcmpl-9');
  });

  it('rejects a Gateway-signed response and reports SDK failures', async () => {
    expect((await probe(client('gateway', '11'.repeat(32)), MODEL)).error?.code).toBe('signature.kind_mismatch');
    const failing: ChatProbe = {
      chat: { completions: { create: async () => ({ id: 'x' }) } },
      verifyResponse: async () => {
        throw new VerificationError({ code: 'signature.invalid', details: { signingAlgo: 'ed25519' } });
      },
    };
    expect(await probe(failing, MODEL)).toMatchObject({ ok: false, chatId: 'x', error: { code: 'signature.invalid' } });
  });
});

describe('render', () => {
  it('prints each check and the verdict', async () => {
    const { report } = await attestModel({ verify: async () => result([modelAttestation('5a'.repeat(32))]) }, MODEL, { key: '5a'.repeat(32) });
    const text = render({ ok: true, sdk: '0.3.0', contract: DEFAULT_CONTRACT, reports: [report] });
    expect(text).toContain(`VERIFIED ${MODEL}`);
    expect(text).toContain('is bound by an attested model report');
    expect(text).toContain('All checks passed');
  });
});

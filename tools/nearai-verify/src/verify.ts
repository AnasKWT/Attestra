/**
 * NEAR AI Cloud evidence checked with the official `@nearai/inference-sdk`, independently of the
 * agent's own verification code: the Gateway and model TEE attestations (Intel TDX quote, NVIDIA
 * GPU evidence, the signing key bound to the quote), whether a key a contract trusts is one of the
 * attested model signers, and a chat response signature against its exact request and response bytes.
 *
 * The network sits behind small interfaces (`AttestationVerifier`, `SignatureSource`, `ChatProbe`)
 * so the decisions here are unit tested without live calls.
 */

import {
  findModelAttestationsForSignature,
  getSdkError,
  verifyModelResponse,
  type AttestationVerificationResult,
  type CompletionSignature,
  type SigningAlgo,
  type VerifiedCompletionResult,
  type VerifiedModelAttestation,
} from '@nearai/inference-sdk/node';

/** A model signer a contract trusts, as `get_config().model_signers` lists it. */
export interface TrustedSigner {
  model: string;
  algo: SigningAlgo;
  key: string;
}

/** One model report the SDK verified. */
export interface AttestedSigner {
  algo: SigningAlgo;
  /** The quote-bound signing identity: the ed25519 public key, or the ecdsa address (hex, lowercase). */
  key: string;
  /** The quote-bound model public key used for E2EE, when the report carries one. */
  publicKey?: string;
  tcbStatus: string;
  advisoryIds: string[];
  gpuEvidence: 'verified' | 'not_provided';
  osImageHash?: string;
  composeHash?: string;
}

export interface Failure {
  code?: string;
  message: string;
}

export interface ResponseReport {
  ok: boolean;
  chatId: string;
  kind?: string;
  signer?: string;
  signedText?: string;
  trusted?: boolean;
  error?: Failure;
}

export interface ModelReport {
  model: string;
  ok: boolean;
  /** What the SDK proved, one line per step. */
  checks: string[];
  gateway?: { algo: SigningAlgo; key: string; tcbStatus: string; tlsBinding: string };
  signers: AttestedSigner[];
  /** The allowlisted key and whether an attested report binds it. */
  trusted?: { key: string; attested: boolean };
  response?: ResponseReport;
  error?: Failure;
}

/** `InferenceClient.verify(model)`: Gateway and model attestation, rejected on any failure. */
export interface AttestationVerifier {
  verify(model: string): Promise<AttestationVerificationResult>;
}

/** `AttestationClient.fetchCompletionSignature`. */
export interface SignatureSource {
  fetchCompletionSignature(params: { completionId: string; signingAlgo?: SigningAlgo }): Promise<CompletionSignature>;
}

/** The two `InferenceClient` calls a probe needs: one completion, then its byte-exact verification. */
export interface ChatProbe {
  chat: { completions: { create(body: { model: string; messages: Array<{ role: 'user'; content: string }>; max_tokens: number }): Promise<{ id: string }> } };
  verifyResponse(id: string): Promise<VerifiedCompletionResult>;
}

export const normHex = (s: string) => s.trim().replace(/^0x/i, '').toLowerCase();
const short = (hex: string) => (hex.length > 20 ? `${hex.slice(0, 12)}...${hex.slice(-6)}` : hex);

/** A structured SDK failure (`code` is the SDK's stable contract), or the plain message. */
export function failure(e: unknown): Failure {
  const sdk = getSdkError(e);
  if (sdk) return { code: sdk.failure.code, message: sdk.message };
  return { message: e instanceof Error ? e.message : String(e) };
}

export function toSigner(a: VerifiedModelAttestation): AttestedSigner {
  const m = a.deployment.runtimeMeasurements;
  return {
    algo: a.signer.signingAlgo,
    key: normHex(a.signer.signingAddress),
    ...(a.signingPublicKey ? { publicKey: normHex(a.signingPublicKey) } : {}),
    tcbStatus: a.tcbStatus,
    advisoryIds: [...a.advisoryIds],
    gpuEvidence: a.gpuEvidence,
    ...(m.osImageHash ? { osImageHash: m.osImageHash } : {}),
    ...(m.composeHash ? { composeHash: m.composeHash } : {}),
  };
}

/** True when an attested report binds `key` (its signing identity or its quote-bound public key). */
export function bindsKey(signers: readonly AttestedSigner[], key: string, algo?: SigningAlgo): boolean {
  const k = normHex(key);
  return signers.some((s) => (!algo || s.algo === algo) && (s.key === k || s.publicKey === k));
}

/**
 * Verifies the Gateway and every model report for `model` with the SDK and, when `trusted` is
 * given, that one of the attested reports binds that key. Never throws; `models` are the verified
 * reports a later response check needs.
 */
export async function attestModel(
  verifier: AttestationVerifier,
  model: string,
  trusted?: { key: string; algo?: SigningAlgo },
  tries = 4,
  delayMs = 1500,
): Promise<{ report: ModelReport; models: readonly VerifiedModelAttestation[] }> {
  let result: AttestationVerificationResult;
  for (let i = 1; ; i++) {
    try {
      result = await verifier.verify(model);
      break;
    } catch (e) {
      // Intel's quote collateral or a TEE node can be briefly unavailable; the SDK marks those retryable.
      if (i < tries && retryable(e)) {
        await new Promise((r) => setTimeout(r, delayMs * i));
        continue;
      }
      return { report: { model, ok: false, checks: [], signers: [], error: failure(e) }, models: [] };
    }
  }
  return { report: judge(model, result, trusted), models: result.models };
}

/** NEAR AI's caching proxy for Intel's collateral service, used when Intel's own service does not answer. */
export const NEAR_AI_PCCS_URL = 'https://cloud.near.ai/api/proxy/pccs';

/**
 * `attestModel` against Intel's collateral service first; when that collateral is unavailable, again
 * through `fallback` (a verifier fetching collateral from NEAR AI's PCCS cache). The collateral is
 * signed by Intel and checked against Intel's root CA either way, so the cache cannot forge it.
 * Returns the verifier that succeeded, for the response checks that follow.
 */
export async function attestModelWithFallback<V extends AttestationVerifier>(
  primary: V,
  fallback: (() => V) | undefined,
  model: string,
  trusted?: { key: string; algo?: SigningAlgo },
  tries?: number,
  delayMs?: number,
): Promise<{ report: ModelReport; models: readonly VerifiedModelAttestation[]; verifier: V }> {
  const first = await attestModel(primary, model, trusted, tries, delayMs);
  if (first.report.error?.code !== 'quote.collateral_unavailable' || !fallback) return { ...first, verifier: primary };
  const verifier = fallback();
  const second = await attestModel(verifier, model, trusted, tries, delayMs);
  const note = `Collateral: Intel's PCS did not answer, so the quote collateral came from NEAR AI's PCCS cache (${NEAR_AI_PCCS_URL}), still verified against Intel's root CA`;
  return { report: { ...second.report, checks: [...second.report.checks, note] }, models: second.models, verifier };
}

function judge(model: string, result: AttestationVerificationResult, trusted?: { key: string; algo?: SigningAlgo }): ModelReport {
  const g = result.gateway;
  const gateway = {
    algo: g.signer.signingAlgo,
    key: normHex(g.signer.signingAddress),
    tcbStatus: g.tcbStatus,
    tlsBinding: g.tlsBinding.kind === 'attested' ? `attested: the quote binds the TLS key this connection saw (SPKI ${short(g.tlsBinding.spkiFingerprint)})` : 'none',
  };
  const signers = result.models.map(toSigner);
  const checks = [
    `Gateway: Intel TDX quote verified (TCB ${g.tcbStatus}, debug off), report data binds the fresh nonce and its ${gateway.algo} signer ${short(gateway.key)}, compose bound to MRCONFIGID, RTMR3 replayed; TLS ${gateway.tlsBinding}`,
  ];
  if (!signers.length) {
    return {
      model,
      ok: false,
      checks,
      gateway,
      signers,
      error: { code: 'model.not_attested', message: `${model} has no model attestation (Gateway-only Incognito flow): its responses are not signed inside a model TEE` },
    };
  }
  const gpu = signers.filter((s) => s.gpuEvidence === 'verified').length;
  checks.push(
    `Model: ${signers.length === 1 ? '1 report, its' : `${signers.length} reports, each with its`} Intel TDX quote verified (TCB ${[...new Set(signers.map((s) => s.tcbStatus))].join(', ')}, debug off), report data binds the fresh nonce and the signer, compose bound to MRCONFIGID, RTMR3 replayed`,
    `GPU: NVIDIA evidence verified by NRAS, bound to the same nonce, for ${gpu} of ${signers.length} report${signers.length === 1 ? '' : 's'}`,
    `Attested signer${signers.length === 1 ? '' : 's'}: ${signers.map((s) => `${s.algo} ${s.key}`).join(', ')}`,
  );
  if (!trusted) return { model, ok: true, checks, gateway, signers };
  const attested = bindsKey(signers, trusted.key, trusted.algo);
  checks.push(attested ? `Trusted key ${normHex(trusted.key)} is bound by an attested model report` : `Trusted key ${normHex(trusted.key)} is NOT among the attested signers`);
  return {
    model,
    ok: attested,
    checks,
    gateway,
    signers,
    trusted: { key: normHex(trusted.key), attested },
    ...(attested ? {} : { error: { code: 'trust.key_not_attested', message: `no attested report for ${model} binds the trusted key ${normHex(trusted.key)}` } }),
  };
}

/** Worth another lookup: the SDK calls it retryable, or the signature is not there yet (a lookup can land on another TEE node first). */
export function retryable(e: unknown): boolean {
  const sdk = getSdkError(e);
  if (!sdk) return false;
  const f = sdk.failure;
  return sdk.retryable || f.code === 'api.completion_signature_unavailable' || (f.code === 'api.http_status' && f.details.status === 404);
}

/** Fetches a chat signature, retrying a few times while the failure is `retryable`. */
export async function fetchSignature(source: SignatureSource, chatId: string, algo: SigningAlgo, tries = 5, delayMs = 800): Promise<CompletionSignature> {
  for (let i = 1; ; i++) {
    try {
      return await source.fetchCompletionSignature({ completionId: chatId, signingAlgo: algo });
    } catch (e) {
      if (i >= tries || !retryable(e)) throw e;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}

/**
 * Verifies a chat's signature with the SDK: it must be a `provider_tee` signature whose text is
 * `{model}:{sha256(request)}:{sha256(response)}` over the exact bytes given, valid under its signer,
 * and that signer must be bound by one of the verified model reports. Never throws.
 */
export async function verifyChat(params: {
  source: SignatureSource;
  chatId: string;
  requestBody: Uint8Array;
  responseBody: Uint8Array;
  attestations: readonly VerifiedModelAttestation[];
  algo: SigningAlgo;
  trustedKey?: string;
}): Promise<ResponseReport> {
  const { chatId } = params;
  let signature: CompletionSignature;
  try {
    signature = await fetchSignature(params.source, chatId, params.algo);
  } catch (e) {
    return { ok: false, chatId, error: failure(e) };
  }
  const base = { chatId, kind: signature.kind, signer: normHex(signature.signer.signingAddress), signedText: signature.signedText };
  if (signature.kind !== 'provider_tee') {
    return { ok: false, ...base, error: { code: 'signature.kind_mismatch', message: 'the Gateway signed this response, not the model TEE' } };
  }
  try {
    const matches = findModelAttestationsForSignature({ attestations: params.attestations, signature });
    verifyModelResponse({ requestBody: params.requestBody, responseBody: params.responseBody, signature, attestation: matches[0] });
  } catch (e) {
    return { ok: false, ...base, error: failure(e) };
  }
  return withTrust({ ok: true, ...base }, params.trustedKey);
}

/** Sends one tiny completion through the SDK client and verifies its signature with `verifyResponse`. Never throws. */
export async function probe(client: ChatProbe, model: string, trustedKey?: string): Promise<ResponseReport> {
  let id = '';
  try {
    id = (await client.chat.completions.create({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 16 })).id;
    const r = await client.verifyResponse(id);
    const base = { chatId: id, kind: r.signatureKind, signer: normHex(r.signature.signer.signingAddress), signedText: r.signature.signedText };
    if (r.signatureKind !== 'provider_tee') {
      return { ok: false, ...base, error: { code: 'signature.kind_mismatch', message: 'the Gateway signed this response, not the model TEE' } };
    }
    return withTrust({ ok: true, ...base }, trustedKey);
  } catch (e) {
    return { ok: false, chatId: id, error: failure(e) };
  }
}

function withTrust(r: ResponseReport, trustedKey?: string): ResponseReport {
  if (!trustedKey) return r;
  const trusted = r.signer === normHex(trustedKey);
  return trusted ? { ...r, trusted } : { ...r, ok: false, trusted, error: { code: 'trust.signer_not_trusted', message: `signed by ${r.signer}, not the trusted key ${normHex(trustedKey)}` } };
}

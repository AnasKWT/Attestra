/**
 * NEAR AI Cloud client: verifiable model selection, chat completions, response signatures, the
 * attested model key for end-to-end encryption, and signature checks.
 *
 * Only models listed with `verifiable: true` run inside a TEE; this module never picks any other.
 * A chat's signature covers `{model}:{sha256(request body)}:{sha256(response body)}` (or the
 * gateway's two-part form) and is checked against the key the attestation report names.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, fetchWithRetry, hexToBytes } from '@attestra/sdk';

export const NEAR_AI = 'https://cloud-api.near.ai/v1';
export const VERIFY_URL = 'https://cloud.near.ai/verify';

/** Preferred verifiable models, cheapest capable first; the live list decides. */
export const PREFERRED = ['z-ai/glm-5.3-flash', 'Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3'];

export interface Signature {
  text: string;
  signature: string;
  signing_address?: string;
  signing_algo: 'ecdsa' | 'ed25519';
  signature_kind?: string;
}

export const sha256Hex = (s: string) => bytesToHex(sha256(new TextEncoder().encode(s)));

export class NearAi {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(extra: Record<string, string> = {}) {
    if (!this.apiKey) throw new Error('NEARAI_API_KEY is not set');
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', ...extra };
  }

  /** Verifiable model ids from the live list (no key needed). */
  async verifiableModels(): Promise<string[]> {
    const res = await fetchWithRetry(`${NEAR_AI}/model/list`, {}, { fetchImpl: this.fetchImpl });
    if (!res.ok) throw new Error(`model list answered ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ modelId?: string; id?: string; metadata?: { verifiable?: boolean }; verifiable?: boolean }> };
    return (body.models ?? []).filter((m) => m.metadata?.verifiable === true || m.verifiable === true).map((m) => String(m.modelId ?? m.id));
  }

  async pickModel(wanted?: string): Promise<string> {
    const live = await this.verifiableModels();
    if (wanted) {
      if (!live.includes(wanted)) throw new Error(`${wanted} is not a verifiable model on NEAR AI Cloud`);
      return wanted;
    }
    const pick = PREFERRED.find((m) => live.includes(m)) ?? live.find((m) => !/embedding|reranker|whisper|flux|filter/i.test(m));
    if (!pick) throw new Error('no verifiable chat model is listed');
    return pick;
  }

  /** Sends exactly `body` (a JSON string) and returns the parsed response with both hashes. */
  async chatRaw(body: string, extraHeaders: Record<string, string> = {}): Promise<{ json: ChatResponse; requestHash: string; responseHash: string; raw: string }> {
    // A completion spends credits: retried only on answers that say it was not processed (429, 503).
    const res = await fetchWithRetry(`${NEAR_AI}/chat/completions`, { method: 'POST', headers: this.headers(extraHeaders), body }, { write: true, fetchImpl: this.fetchImpl });
    const raw = await res.text();
    if (!res.ok) throw new Error(`NEAR AI answered ${res.status}: ${raw.slice(0, 300)}`);
    return { json: JSON.parse(raw) as ChatResponse, requestHash: sha256Hex(body), responseHash: sha256Hex(raw), raw };
  }

  /** The chat's signature; retried because a lookup can land on another TEE node at first. */
  async signature(chatId: string, model: string, algo: 'ecdsa' | 'ed25519' = 'ecdsa'): Promise<Signature> {
    let last = '';
    for (let i = 0; i < 6; i++) {
      const res = await this.fetchImpl(`${NEAR_AI}/signature/${chatId}?model=${encodeURIComponent(model)}&signing_algo=${algo}`, { headers: this.headers() });
      if (res.ok) return (await res.json()) as Signature;
      last = `${res.status} ${await res.text()}`;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
    throw new Error(`no signature for chat ${chatId}: ${last.slice(0, 200)}`);
  }

  /** The attested model's ed25519 public key (hex) used for end-to-end encryption, and its ecdsa address. */
  async modelKeys(model: string): Promise<{ ed25519: string; address?: string }> {
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const res = await fetchWithRetry(`${NEAR_AI}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519&nonce=${nonce}`, { headers: this.headers() }, { fetchImpl: this.fetchImpl });
    if (!res.ok) throw new Error(`attestation report answered ${res.status}`);
    const body = (await res.json()) as { model_attestations?: Array<{ signing_public_key?: string; signing_address?: string }>; signing_public_key?: string };
    const a = body.model_attestations?.[0];
    const key = a?.signing_public_key ?? body.signing_public_key;
    if (!key) throw new Error('the attestation report has no ed25519 signing key');
    return { ed25519: key.replace(/^0x/, ''), address: a?.signing_address };
  }
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{ message: { role: string; content?: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }>;
}

/** The request and response hashes a signed text names (last two `:` fields). */
export function signedHashes(text: string): { model?: string; requestHash: string; responseHash: string } {
  const parts = text.split(':');
  const responseHash = parts.pop() ?? '';
  const requestHash = parts.pop() ?? '';
  return { model: parts.length ? parts.join(':') : undefined, requestHash, responseHash };
}

/** Checks a NEAR AI signature: EIP-191 secp256k1 against an address, or ed25519 against a key. */
export function verifySignature(sig: Signature, expected: { address?: string; ed25519?: string }): boolean {
  try {
    if (sig.signing_algo === 'ed25519') {
      const key = hexToBytes((expected.ed25519 ?? sig.signing_address ?? '').replace(/^0x/, ''));
      return ed25519.verify(hexToBytes(sig.signature.replace(/^0x/, '')), new TextEncoder().encode(sig.text), key);
    }
    const msg = new TextEncoder().encode(sig.text);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
    const digest = keccak_256(new Uint8Array([...prefix, ...msg]));
    const raw = hexToBytes(sig.signature.replace(/^0x/, ''));
    const v = raw[64] >= 27 ? raw[64] - 27 : raw[64];
    const s = secp256k1.Signature.fromBytes(raw.slice(0, 64), 'compact').addRecoveryBit(v);
    const pub = s.recoverPublicKey(digest).toBytes(false);
    const addr = `0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`;
    return addr.toLowerCase() === (expected.address ?? sig.signing_address ?? '').toLowerCase();
  } catch {
    return false;
  }
}

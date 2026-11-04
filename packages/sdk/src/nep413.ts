/**
 * Delegated attestations and revocations with NEP-413 signatures.
 *
 * The attester signs a request off chain (with a key it registered on the attestations contract
 * through `addSignerKey`, or the key behind an implicit account), and anyone submits it, usually
 * the relayer, so the attester needs no NEAR for gas. The contract checks the signature, the
 * deadline and that the nonce was never used.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { BorshWriter, base58Decode, base58Encode, bytesToBase64 } from './borsh';

export const NEP413_TAG = 2_147_484_061; // 2^31 + 413

export interface DelegatedAttest {
  action: 'attest';
  attester: string;
  schema_uid: string;
  subject: string;
  /** Base64 Borsh bytes. */
  data: string;
  expiration_time?: number | null;
  ref_uid?: string | null;
  /** Unix seconds after which the request is no longer valid. */
  deadline: number;
}

export interface DelegatedRevoke {
  action: 'revoke';
  attester: string;
  uid: string;
  deadline: number;
}

export type DelegatedAction = DelegatedAttest | DelegatedRevoke;

/** What `submit_signed` takes. */
export interface SignedRequest {
  message: string;
  /** base64 of 32 bytes */
  nonce: string;
  /** `ed25519:<base58>` */
  public_key: string;
  /** base64 of 64 bytes */
  signature: string;
  callback_url: string | null;
}

/** Signs NEP-413 payloads: a wallet, near-kit's `Near#signMessage`, or a raw key. */
export interface MessageSigner {
  signMessage(params: { message: string; recipient: string; nonce: Uint8Array }): Promise<{ publicKey: string; signature: string }>;
}

/** The exact JSON text the attester signs; key order is fixed so it can be reproduced. */
export function buildMessage(action: DelegatedAction): string {
  if (action.action === 'attest') {
    const o: Record<string, unknown> = {
      action: 'attest',
      attester: action.attester,
      schema_uid: action.schema_uid,
      subject: action.subject,
      data: action.data,
    };
    if (action.expiration_time) o.expiration_time = action.expiration_time;
    if (action.ref_uid) o.ref_uid = action.ref_uid;
    o.deadline = action.deadline;
    return JSON.stringify(o);
  }
  return JSON.stringify({ action: 'revoke', attester: action.attester, uid: action.uid, deadline: action.deadline });
}

/** SHA-256 of the NEP-413 Borsh payload: what an ed25519 key signs. */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string, callbackUrl: string | null = null): Uint8Array {
  const w = new BorshWriter()
    .u32(NEP413_TAG)
    .string(message)
    .fixed(nonce)
    .string(recipient)
    .option(callbackUrl, (w, c) => w.string(c));
  return sha256(w.toBytes());
}

export function randomNonce(): Uint8Array {
  const n = new Uint8Array(32);
  globalThis.crypto.getRandomValues(n);
  return n;
}

function decodeSignature(signature: string): Uint8Array {
  const raw = signature.includes(':') ? signature.split(':')[1] : signature;
  try {
    const b = base58Decode(raw);
    if (b.length === 64) return b;
  } catch {
    // not base58; try base64 below
  }
  const bin = atob(raw);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Signs a delegated action for `recipient` (the attestations contract). */
export async function signRequest(signer: MessageSigner, action: DelegatedAction, recipient: string): Promise<SignedRequest> {
  const message = buildMessage(action);
  const nonce = randomNonce();
  const signed = await signer.signMessage({ message, recipient, nonce });
  return {
    message,
    nonce: bytesToBase64(nonce),
    public_key: signed.publicKey,
    signature: bytesToBase64(decodeSignature(signed.signature)),
    callback_url: null,
  };
}

/** A `MessageSigner` from a raw `ed25519:<base58 secret>` key (64-byte NEAR secret or 32-byte seed). */
export function keySigner(secretKey: string): MessageSigner & { publicKey: string } {
  const raw = base58Decode(secretKey.replace(/^ed25519:/, ''));
  const seed = raw.length === 64 ? raw.slice(0, 32) : raw;
  const pub = ed25519.getPublicKey(seed);
  const publicKey = `ed25519:${base58Encode(pub)}`;
  return {
    publicKey,
    async signMessage({ message, recipient, nonce }) {
      const digest = nep413Hash(message, nonce, recipient);
      return { publicKey, signature: `ed25519:${base58Encode(ed25519.sign(digest, seed))}` };
    },
  };
}

/** Verifies a signed request off chain exactly as the contract does (key ownership aside). */
export function verifyRequest(req: SignedRequest, recipient: string): boolean {
  const pk = base58Decode(req.public_key.replace(/^ed25519:/, ''));
  const nonce = Uint8Array.from(atob(req.nonce), (c) => c.charCodeAt(0));
  const sig = Uint8Array.from(atob(req.signature), (c) => c.charCodeAt(0));
  return ed25519.verify(sig, nep413Hash(req.message, nonce, recipient, req.callback_url), pk);
}

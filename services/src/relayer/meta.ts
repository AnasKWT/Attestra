/**
 * NEP-366 meta transactions: the relayer pays the gas only for delegate actions whose receiver is
 * an Attestra contract or the payment token (x402 settlement), and only for function calls.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import { base58Encode, type NetworkConfig } from 'attestra';
import { DELEGATE_ACTION_PREFIX, decodeSignedDelegateAction, encodeSignedDelegateAction, type SignedDelegateAction } from 'near-kit';
import type { Checked } from './policy';

/** DER header of an ed25519 SubjectPublicKeyInfo, followed by the 32 raw key bytes. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** Every account a relayed delegate action may target. */
export function metaReceivers(net: Pick<NetworkConfig, 'contracts' | 'paymentToken'>): Set<string> {
  const c = net.contracts;
  return new Set([c.schemas, c.attestations, c.verdicts, c.credentials, c.staking, c.token, ...Object.values(c.resolvers), net.paymentToken]);
}

export interface DecodedMeta {
  signed: SignedDelegateAction;
  sender: string;
  receiver: string;
  methods: string[];
  /** `ed25519:<base58>` key that signed the delegate action. */
  publicKey: string;
}

/**
 * Checks the NEP-366 signature off chain: ed25519 over sha256(u32 NEP-461 prefix || borsh(delegate
 * action)). The borsh bytes are the encoded signed delegate without its trailing 65-byte signature.
 */
export function verifyDelegateSignature(signed: SignedDelegateAction): { ok: boolean; publicKey?: string } {
  const { delegateAction, signature } = signed.signedDelegate;
  if (!('ed25519Key' in delegateAction.publicKey) || !('ed25519Signature' in signature)) return { ok: false };
  const key = Uint8Array.from(delegateAction.publicKey.ed25519Key.data);
  const sig = Uint8Array.from(signature.ed25519Signature.data);
  if (key.length !== 32 || sig.length !== 64) return { ok: false };
  const bytes = encodeSignedDelegateAction(signed, 'bytes');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(DELEGATE_ACTION_PREFIX);
  const digest = createHash('sha256').update(prefix).update(bytes.subarray(0, bytes.length - 65)).digest();
  const pub = createPublicKey({ key: Buffer.concat([ED25519_SPKI, key]), format: 'der', type: 'spki' });
  return { ok: verify(null, digest, pub, sig), publicKey: `ed25519:${base58Encode(key)}` };
}

/** Decodes the base64 payload and checks the receiver and the actions. */
export function checkMeta(payload: unknown, allowed: Set<string>): Checked<DecodedMeta> {
  if (typeof payload !== 'string' || !payload) return { ok: false, status: 400, error: 'body must be { signed_delegate: base64 }' };
  let signed: SignedDelegateAction;
  try {
    signed = decodeSignedDelegateAction(payload);
  } catch {
    return { ok: false, status: 400, error: 'signed_delegate is not a base64 NEP-366 signed delegate action' };
  }
  const da = signed.signedDelegate?.delegateAction;
  if (!da) return { ok: false, status: 400, error: 'no delegate action' };
  if (!allowed.has(da.receiverId)) return { ok: false, status: 403, error: `the relayer does not pay for calls to ${da.receiverId}` };
  if (da.actions.length === 0) return { ok: false, status: 400, error: 'the delegate action has no actions' };
  const methods: string[] = [];
  for (const a of da.actions) {
    if (!('functionCall' in a)) return { ok: false, status: 403, error: 'only function calls can be relayed' };
    methods.push(a.functionCall.methodName);
  }
  const sig = verifyDelegateSignature(signed);
  if (!sig.ok || !sig.publicKey) return { ok: false, status: 401, error: 'invalid delegate action signature (ed25519 keys only)' };
  return { ok: true, value: { signed, sender: da.senderId, receiver: da.receiverId, methods, publicKey: sig.publicKey } };
}

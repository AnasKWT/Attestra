/**
 * Passkey accounts: a WebAuthn passkey with the PRF extension derives a stable 32-byte secret
 * inside the authenticator; that secret is the seed of an ed25519 key whose implicit NEAR account
 * (64 hex characters) belongs to whoever holds the passkey. No seed phrase, no wallet app.
 * The relayer funds the account on first use so it can sign meta transactions and NEP-413 messages.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode, bytesToHex } from '@attestra/sdk';

const STORE = 'attestra.passkey';
const SALT = new TextEncoder().encode('attestra:passkey:ed25519:v1');

export interface PasskeyAccount {
  accountId: string;
  publicKey: string;
  secretKey: string;
  credentialId: string;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export function passkeySupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

function accountFromSeed(seed: Uint8Array, credentialId: string): PasskeyAccount {
  const pub = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pub, 32);
  return { accountId: bytesToHex(pub), publicKey: `ed25519:${base58Encode(pub)}`, secretKey: `ed25519:${base58Encode(full)}`, credentialId };
}

async function derive(credentialId?: string): Promise<PasskeyAccount> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: window.location.hostname,
      userVerification: 'required',
      allowCredentials: credentialId ? [{ type: 'public-key', id: fromB64url(credentialId) as BufferSource }] : [],
      extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('no passkey was used');
  const prf = (cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
  if (!prf) throw new Error('this passkey cannot derive keys (the PRF extension is unsupported here); use a wallet instead');
  return accountFromSeed(new Uint8Array(prf).slice(0, 32), b64url(cred.rawId));
}

/** Creates a passkey for this site, then derives its account. */
export async function createPasskeyAccount(label = 'Attestra'): Promise<PasskeyAccount> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Attestra', id: window.location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('the passkey was not created');
  const account = await derive(b64url(cred.rawId));
  localStorage.setItem(STORE, account.credentialId);
  return account;
}

/** Signs in with an existing passkey (the browser offers the ones it has for this site). */
export async function signInWithPasskey(): Promise<PasskeyAccount> {
  const account = await derive(localStorage.getItem(STORE) ?? undefined);
  localStorage.setItem(STORE, account.credentialId);
  return account;
}

export function forgetPasskey(): void {
  localStorage.removeItem(STORE);
}

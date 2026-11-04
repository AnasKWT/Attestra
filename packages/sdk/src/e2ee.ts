/**
 * End-to-end encryption for NEAR AI Cloud (protocol v2): evidence is encrypted in the browser to
 * the attested model's ed25519 key (converted to X25519), so neither Attestra, the enclave that
 * builds the request, nor the NEAR AI gateway can read it. Only the model's TEE can decrypt.
 *
 * Wire format (hex): [ephemeral X25519 public key (32)][nonce (24)][XChaCha20-Poly1305 ciphertext + tag].
 * Key: HKDF-SHA256(shared secret, info "ed25519_encryption", 32 bytes).
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from './borsh';

const INFO = new TextEncoder().encode('ed25519_encryption');

function random(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** Encrypts `plaintext` to a model's ed25519 public key (hex). Returns hex. */
export function encryptForModel(plaintext: string, modelEd25519PubHex: string): string {
  const recipient = ed25519.utils.toMontgomery(hexToBytes(modelEd25519PubHex));
  const eph = random(32);
  const shared = x25519.getSharedSecret(eph, recipient);
  const key = hkdf(sha256, shared, undefined, INFO, 32);
  const nonce = random(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(plaintext));
  const out = new Uint8Array(32 + 24 + ct.length);
  out.set(x25519.getPublicKey(eph), 0);
  out.set(nonce, 32);
  out.set(ct, 56);
  return bytesToHex(out);
}

/** Decrypts a hex payload addressed to an ed25519 secret seed (32 bytes). */
export function decryptWithEd25519Seed(payloadHex: string, ed25519Seed: Uint8Array): string {
  const data = hexToBytes(payloadHex);
  const secret = ed25519.utils.toMontgomerySecret(ed25519Seed);
  const shared = x25519.getSharedSecret(secret, data.slice(0, 32));
  const key = hkdf(sha256, shared, undefined, INFO, 32);
  const pt = xchacha20poly1305(key, data.slice(32, 56)).decrypt(data.slice(56));
  return new TextDecoder().decode(pt);
}

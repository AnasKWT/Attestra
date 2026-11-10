//! End-to-end encryption for NEAR AI Cloud (protocol v2), byte compatible with
//! `packages/sdk/src/e2ee.ts`.
//!
//! Wire format (hex): `[ephemeral X25519 public key (32)][nonce (24)][XChaCha20-Poly1305 ciphertext + tag]`.
//! Key: HKDF-SHA256(shared secret, no salt, info "ed25519_encryption", 32 bytes).
//! The recipient's ed25519 public key is converted to its X25519 (Montgomery) form; an ed25519
//! seed decrypts with the X25519 secret derived from it (the first half of SHA-512 of the seed).

use crate::Result;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::{SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

const INFO: &[u8] = b"ed25519_encryption";
const HEADER: usize = 32 + 24;

fn symmetric_key(secret: &StaticSecret, their_public: &PublicKey) -> Result<[u8; 32]> {
    let shared = secret.diffie_hellman(their_public);
    if !shared.was_contributory() {
        return Err("the X25519 shared secret is degenerate".into());
    }
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared.as_bytes())
        .expand(INFO, &mut key)
        .map_err(|_| "HKDF expand failed".to_string())?;
    Ok(key)
}

/// The X25519 public key of an ed25519 public key given as 64 hex characters.
pub fn x25519_of_ed25519_public(ed25519_pub_hex: &str) -> Result<PublicKey> {
    let bytes: [u8; 32] = hex::decode(ed25519_pub_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("the model key must be 32 bytes of hex")?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| "the model key is not an ed25519 point")?;
    Ok(PublicKey::from(key.to_montgomery().to_bytes()))
}

/// Encrypts `plaintext` to an ed25519 public key (hex) with the given ephemeral X25519 secret and
/// nonce. Returns lowercase hex. Callers pass fresh random values; tests pass fixed ones.
pub fn encrypt_with(
    plaintext: &str,
    model_ed25519_pub_hex: &str,
    ephemeral: [u8; 32],
    nonce: [u8; 24],
) -> Result<String> {
    let recipient = x25519_of_ed25519_public(model_ed25519_pub_hex)?;
    let secret = StaticSecret::from(ephemeral);
    let key = symmetric_key(&secret, &recipient)?;
    let ct = XChaCha20Poly1305::new(&key.into())
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|_| "encryption failed".to_string())?;
    let mut out = Vec::with_capacity(HEADER + ct.len());
    out.extend_from_slice(PublicKey::from(&secret).as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(hex::encode(out))
}

/// Decrypts a hex payload addressed to the ed25519 public key of `ed25519_seed` (32 bytes).
pub fn decrypt_with_ed25519_seed(payload_hex: &str, ed25519_seed: &[u8; 32]) -> Result<String> {
    let data = hex::decode(payload_hex).map_err(|_| "the ciphertext is not hex")?;
    if data.len() < HEADER + 16 {
        return Err("the ciphertext is too short".into());
    }
    let secret = StaticSecret::from(SigningKey::from_bytes(ed25519_seed).to_scalar_bytes());
    let ephemeral: [u8; 32] = data[..32].try_into().expect("32 bytes");
    let key = symmetric_key(&secret, &PublicKey::from(ephemeral))?;
    let pt = XChaCha20Poly1305::new(&key.into())
        .decrypt(XNonce::from_slice(&data[32..HEADER]), &data[HEADER..])
        .map_err(|_| "decryption failed".to_string())?;
    String::from_utf8(pt).map_err(|_| "the plaintext is not UTF-8".to_string())
}

//! NEP-413 off-chain message signing.
//!
//! A wallet signs `sha256(borsh(2^31 + 413) || borsh(Payload))` with an ed25519 access key, where
//! `Payload = { message, nonce: [u8; 32], recipient, callback_url: Option<String> }`.
//! Attestra uses it for delegated attestations and revocations: the attester signs a request,
//! anyone (usually the relayer) submits it, and the contract checks the signature on chain.

use near_sdk::borsh::{self, BorshSerialize};
use near_sdk::env;

/// `2^31 + 413`, the NEP-413 prefix tag.
pub const NEP413_TAG: u32 = 2_147_484_061;

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct Payload<'a> {
    message: &'a str,
    nonce: [u8; 32],
    recipient: &'a str,
    callback_url: Option<String>,
}

/// The 32-byte hash an ed25519 key signs for this NEP-413 payload.
pub fn hash(message: &str, nonce: [u8; 32], recipient: &str, callback_url: Option<String>) -> [u8; 32] {
    let mut bytes = borsh::to_vec(&NEP413_TAG).expect("borsh");
    bytes.extend(borsh::to_vec(&Payload { message, nonce, recipient, callback_url }).expect("borsh"));
    env::sha256_array(&bytes)
}

/// Verifies an ed25519 NEP-413 signature over `message`.
pub fn verify(
    message: &str,
    nonce: [u8; 32],
    recipient: &str,
    callback_url: Option<String>,
    public_key: &[u8; 32],
    signature: &[u8; 64],
) -> bool {
    let digest = hash(message, nonce, recipient, callback_url);
    env::ed25519_verify(signature, digest, public_key)
}

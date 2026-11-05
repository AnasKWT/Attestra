//! Signature helpers: hex parsing, EIP-191 personal messages and Ethereum address recovery.

use near_sdk::env;

/// Decodes hex with an optional `0x` prefix.
pub fn decode_hex(s: &str) -> Option<Vec<u8>> {
    hex::decode(s.strip_prefix("0x").unwrap_or(s)).ok()
}

/// Decodes exactly `N` bytes of hex with an optional `0x` prefix.
pub fn decode_hex_array<const N: usize>(s: &str) -> Option<[u8; N]> {
    decode_hex(s)?.try_into().ok()
}

/// `keccak256("\x19Ethereum Signed Message:\n" + decimal byte length + message)`.
pub fn eip191_hash(message: &[u8]) -> [u8; 32] {
    let mut bytes = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    bytes.extend_from_slice(message);
    env::keccak256_array(&bytes)
}

/// The Ethereum address of a 64-byte uncompressed secp256k1 key.
pub fn eth_address(public_key: &[u8; 64]) -> [u8; 20] {
    let hash = env::keccak256_array(public_key);
    hash[12..].try_into().expect("20 bytes")
}

/// Recovers the address that made a 65-byte `personal_sign` signature over `message`. The last
/// byte is `v`: 27 or 28, or 0 or 1. A high `s` is rejected.
pub fn recover_personal_sign(message: &[u8], signature: &[u8]) -> Option<[u8; 20]> {
    if signature.len() != 65 {
        return None;
    }
    let v = match signature[64] {
        27 | 28 => signature[64] - 27,
        0 | 1 => signature[64],
        _ => return None,
    };
    let recovered = env::ecrecover(&eip191_hash(message), &signature[..64], v, true)?;
    Some(eth_address(&recovered))
}

/// Parses a `0x`-prefixed 20-byte address (any case) into its bytes.
pub fn parse_eth_address(s: &str) -> Option<[u8; 20]> {
    let hex_part = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    if hex_part.len() != 40 {
        return None;
    }
    decode_hex_array(hex_part)
}

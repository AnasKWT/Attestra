//! Shared building blocks for the Attestra contracts: 32-byte UIDs, the deterministic UID
//! derivations, NEP-297 events, the resolver interface, NEP-413 message hashing, subject
//! validation and NEP-145 storage accounting.

pub mod definition;
pub mod events;
pub mod nep413;
pub mod resolver;
pub mod storage;
pub mod uid;

use near_sdk::env;

pub use uid::Uid;

/// Nanoseconds in a second, for converting `env::block_timestamp()`.
pub const NANOS: u64 = 1_000_000_000;

/// Largest attestation payload in bytes.
pub const MAX_DATA_LEN: usize = 16 * 1024;
/// Largest inline schema definition in bytes; larger definitions go through a stored blob.
pub const MAX_DEFINITION_LEN: usize = 16 * 1024;
/// Largest stored blob in bytes.
pub const MAX_BLOB_LEN: usize = 256 * 1024;
/// Largest free-text metadata (authority descriptions, labels) in bytes.
pub const MAX_METADATA_LEN: usize = 2 * 1024;
/// Largest subject identifier in bytes (a CAIP-10 id is at most 3 + 1 + 32 + 1 + 128).
pub const MAX_SUBJECT_LEN: usize = 166;

/// Block time in whole seconds.
pub fn now_secs() -> u64 {
    env::block_timestamp() / NANOS
}

/// True when the single promise this callback waits on succeeded.
pub fn promise_succeeded() -> bool {
    env::promise_results_count() == 1 && env::promise_result_checked(0, 64 * 1024).is_ok()
}

/// The JSON `bool` the single awaited promise returned, or false when it failed or returned
/// anything else.
pub fn promise_bool() -> bool {
    if env::promise_results_count() != 1 {
        return false;
    }
    match env::promise_result_checked(0, 1024) {
        Ok(bytes) => near_sdk::serde_json::from_slice::<bool>(&bytes).unwrap_or(false),
        Err(_) => false,
    }
}

/// A subject is either a NEAR account id or a CAIP-10 account id on another chain
/// (`namespace:reference:address`, for example `eip155:1:0xab...` or `solana:5eykt4Us...:9WzD...`).
pub fn is_valid_subject(subject: &str) -> bool {
    if subject.is_empty() || subject.len() > MAX_SUBJECT_LEN {
        return false;
    }
    if subject.parse::<near_sdk::AccountId>().is_ok() {
        return true;
    }
    is_caip10(subject)
}

/// CAIP-10: `[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}`.
pub fn is_caip10(subject: &str) -> bool {
    let mut parts = subject.splitn(3, ':');
    let (Some(ns), Some(reference), Some(address)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let ns_ok = (3..=8).contains(&ns.len())
        && ns.bytes().all(|c| c == b'-' || c.is_ascii_lowercase() || c.is_ascii_digit());
    let ref_ok = (1..=32).contains(&reference.len())
        && reference.bytes().all(|c| c == b'-' || c == b'_' || c.is_ascii_alphanumeric());
    let addr_ok = (1..=128).contains(&address.len())
        && address.bytes().all(|c| c == b'-' || c == b'.' || c == b'%' || c.is_ascii_alphanumeric());
    ns_ok && ref_ok && addr_ok
}

/// True when `subject` is a NEAR account id (so it can hold a credential or receive a reward).
pub fn near_subject(subject: &str) -> Option<near_sdk::AccountId> {
    if is_caip10(subject) {
        return None;
    }
    subject.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subjects() {
        assert!(is_valid_subject("alice.testnet"));
        assert!(is_valid_subject("eip155:1:0xab5801a7d398351b8be11c439e05c5b3259aec9b"));
        assert!(is_valid_subject(
            "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
        ));
        assert!(!is_valid_subject(""));
        assert!(!is_valid_subject("Not An Account"));
        assert!(!is_valid_subject("eip155::0xab"));
        assert!(!is_valid_subject(&"a".repeat(200)));
        assert_eq!(near_subject("bob.near").unwrap().as_str(), "bob.near");
        assert!(near_subject("eip155:1:0xab5801a7d398351b8be11c439e05c5b3259aec9b").is_none());
    }
}

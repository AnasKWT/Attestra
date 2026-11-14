//! The Attestra private checker, as a library so the pipeline runs natively under `cargo test`
//! against a mocked host, and inside an OutLayer TEE as a WASI P2 component (`src/main.rs`).
//!
//! Input (stdin, one JSON object):
//! - `{"operation": "public_key"}` prints `{"enclaveKey": "ed25519:..."}`, the key the verdicts
//!   contract owner registers with `set_enclave_keys`.
//! - `{"operation": "check", "request_id", "rule_id", "subject", "model", "encrypted_evidence",
//!   "github"}` runs the check and prints the agent's `CheckOutput` (`apps/agent/src/check.ts`).
//!
//! Any failure prints `{"error": "..."}`.

pub mod check;
pub mod e2ee;
pub mod nearai;
pub mod proof;
pub mod verdict;

use serde_json::{json, Value};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Clone, Debug)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Everything the checker needs from where it runs. OutLayer provides it in the TEE
/// (`src/main.rs`); tests provide a mock.
pub trait Host {
    fn http(&self, req: &HttpRequest) -> Result<HttpResponse>;
    /// The ed25519 public key of the build-bound checker key.
    fn public_key(&self) -> Result<[u8; 32]>;
    /// An ed25519 signature by the build-bound checker key.
    fn sign(&self, message: &[u8]) -> Result<[u8; 64]>;
    fn now_secs(&self) -> u64;
    fn random(&self, buf: &mut [u8]) -> Result<()>;
    fn sleep_ms(&self, ms: u64);
    /// An environment variable (OutLayer sets the worker's own variables and the caller's secrets).
    fn env(&self, name: &str) -> Option<String>;
}

/// `ed25519:<base58>`, the NEAR form of a public key.
pub fn near_public_key(key: &[u8; 32]) -> String {
    format!("ed25519:{}", bs58::encode(key).into_string())
}

/// JavaScript's `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Runs one request (the program's stdin) and returns the JSON it prints.
pub fn handle(host: &dyn Host, input: &str) -> Value {
    let run = || -> Result<Value> {
        let request: check::Request =
            serde_json::from_str(input).map_err(|e| format!("invalid input: {e}"))?;
        match request {
            check::Request::PublicKey => Ok(json!({ "enclaveKey": near_public_key(&host.public_key()?) })),
            check::Request::Check(input) => {
                serde_json::to_value(check::run_check(host, &input)?).map_err(|e| e.to_string())
            }
        }
    };
    run().unwrap_or_else(|error| json!({ "error": error }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_javascript() {
        assert_eq!(
            encode_uri_component("type:pr author:octo-cat is:merged"),
            "type%3Apr%20author%3Aocto-cat%20is%3Amerged"
        );
        assert_eq!(encode_uri_component("Qwen/Qwen3.8-27B"), "Qwen%2FQwen3.8-27B");
        assert_eq!(encode_uri_component("a!~*'()_.-é"), "a!~*'()_.-%C3%A9");
    }
}

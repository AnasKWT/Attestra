//! A mocked host: NEAR AI Cloud (decrypts E2EE messages with the model key, answers encrypted to
//! the client key, signs like the gateway), NEAR RPC, GitHub, and a checker key.

#![allow(dead_code)]

use attestra_checker::e2ee::{decrypt_with_ed25519_seed, encrypt_with};
use attestra_checker::nearai::sha256_hex;
use attestra_checker::{Host, HttpRequest, HttpResponse, Method, Result};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;

pub const MODEL: &str = "z-ai/glm-5.3-flash";
pub const NOW: u64 = 1_790_000_000;

pub fn model_seed() -> [u8; 32] {
    [7; 32]
}

pub fn model_pub() -> String {
    hex::encode(SigningKey::from_bytes(&model_seed()).verifying_key().as_bytes())
}

pub fn checker_key() -> SigningKey {
    SigningKey::from_bytes(&[9; 32])
}

/// Encrypts to the model key with fixed randomness (what a browser does with random values).
pub fn evidence(plaintext: &str) -> String {
    encrypt_with(plaintext, &model_pub(), [0x42; 32], [0x24; 24]).unwrap()
}

pub struct Mock {
    pub answer: String,
    pub rules: Value,
    pub github_count: u64,
    pub env: Vec<(&'static str, String)>,
    /// Signature lookups that answer 404 before one succeeds.
    pub signature_misses: u32,
    /// Sign this request hash instead of the real one.
    pub sign_request_hash: Option<String>,
    /// Sign this response hash instead of the real one.
    pub sign_response_hash: Option<String>,
    /// Sign with this seed instead of the model's.
    pub signer_seed: Option<[u8; 32]>,
    /// Answer the model in plaintext instead of encrypting to the client.
    pub plaintext_answer: bool,
    /// RPC URLs that answer 500.
    pub failing_rpc: Vec<&'static str>,

    pub requests: RefCell<Vec<HttpRequest>>,
    pub seen: RefCell<Vec<String>>,
    pub sleeps: RefCell<Vec<u64>>,
    chat: RefCell<Option<(Vec<u8>, Vec<u8>)>>,
    counter: RefCell<u64>,
}

impl Mock {
    pub fn new(answer: &str) -> Self {
        Self {
            answer: answer.into(),
            rules: json!([
                { "id": "age_over_18", "claim": "is at least 18 years old", "enabled": true },
                { "id": "github_contributor", "claim": "has at least 10 merged pull requests on GitHub", "enabled": true },
                { "id": "retired", "claim": "is retired", "enabled": false },
            ]),
            github_count: 12,
            env: vec![("NEAR_NETWORK_ID", "testnet".into()), ("NEARAI_API_KEY", "test-key".into())],
            signature_misses: 0,
            sign_request_hash: None,
            sign_response_hash: None,
            signer_seed: None,
            plaintext_answer: false,
            failing_rpc: vec![],
            requests: RefCell::new(vec![]),
            seen: RefCell::new(vec![]),
            sleeps: RefCell::new(vec![]),
            chat: RefCell::new(None),
            counter: RefCell::new(0),
        }
    }

    pub fn requests_to(&self, needle: &str) -> Vec<HttpRequest> {
        self.requests.borrow().iter().filter(|r| r.url.contains(needle)).cloned().collect()
    }

    fn respond(status: u16, body: impl Into<Vec<u8>>) -> Result<HttpResponse> {
        Ok(HttpResponse { status, body: body.into() })
    }

    fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
        req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

impl Host for Mock {
    fn http(&self, req: &HttpRequest) -> Result<HttpResponse> {
        self.requests.borrow_mut().push(req.clone());
        let url = req.url.as_str();
        if url.contains("fastnear.com") {
            if self.failing_rpc.contains(&url) {
                return Self::respond(500, "down");
            }
            assert_eq!(req.method, Method::Post);
            let body: Value = serde_json::from_slice(req.body.as_ref().unwrap()).unwrap();
            assert_eq!(body["params"]["account_id"], "verdicts.attestra.testnet");
            assert_eq!(body["params"]["method_name"], "get_rules");
            let bytes: Vec<u8> = serde_json::to_vec(&self.rules).unwrap();
            return Self::respond(
                200,
                json!({ "jsonrpc": "2.0", "id": "x", "result": { "result": bytes, "logs": [] } }).to_string(),
            );
        }
        if url.starts_with("https://api.github.com/") {
            return Self::respond(200, json!({ "total_count": self.github_count }).to_string());
        }
        assert!(url.starts_with("https://cloud-api.near.ai/v1/"), "unexpected host: {url}");
        assert_eq!(Self::header(req, "authorization"), Some("Bearer test-key"));
        if url.contains("/attestation/report") {
            return Self::respond(200, json!({ "model_attestations": [{ "signing_public_key": model_pub(), "signing_address": "0xabc" }], "intel_quote": "00".repeat(512) }).to_string());
        }
        if url.ends_with("/chat/completions") {
            let raw = req.body.clone().unwrap();
            let body: Value = serde_json::from_slice(&raw).unwrap();
            *self.seen.borrow_mut() = body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| decrypt_with_ed25519_seed(m["content"].as_str().unwrap(), &model_seed()).unwrap())
                .collect();
            let client = Self::header(req, "X-Client-Pub-Key").unwrap();
            let content = if self.plaintext_answer {
                self.answer.clone()
            } else {
                encrypt_with(&self.answer, client, [0x11; 32], [0x22; 24]).unwrap()
            };
            let res = json!({ "id": "chat-1", "model": MODEL, "choices": [{ "message": { "role": "assistant", "content": content } }] }).to_string();
            *self.chat.borrow_mut() = Some((raw, res.clone().into_bytes()));
            return Self::respond(200, res);
        }
        if url.contains("/signature/chat-1") {
            if self.signature_misses > 0
                && self.requests_to("/signature/").len() as u32 <= self.signature_misses
            {
                return Self::respond(404, "Chat id not found or expired");
            }
            let (req_body, res_body) = self.chat.borrow().clone().unwrap();
            let text = format!(
                "{MODEL}:{}:{}",
                self.sign_request_hash.clone().unwrap_or_else(|| sha256_hex(&req_body)),
                self.sign_response_hash.clone().unwrap_or_else(|| sha256_hex(&res_body))
            );
            let key = SigningKey::from_bytes(&self.signer_seed.unwrap_or_else(model_seed));
            let signature = hex::encode(key.sign(text.as_bytes()).to_bytes());
            return Self::respond(200, json!({ "text": text, "signature": format!("0x{signature}"), "signing_address": model_pub(), "signing_algo": "ed25519" }).to_string());
        }
        Self::respond(404, "nope")
    }

    fn public_key(&self) -> Result<[u8; 32]> {
        Ok(checker_key().verifying_key().to_bytes())
    }

    fn sign(&self, message: &[u8]) -> Result<[u8; 64]> {
        Ok(checker_key().sign(message).to_bytes())
    }

    fn now_secs(&self) -> u64 {
        NOW
    }

    fn random(&self, buf: &mut [u8]) -> Result<()> {
        let mut counter = self.counter.borrow_mut();
        *counter += 1;
        let block = Sha256::digest(counter.to_le_bytes());
        for (i, b) in buf.iter_mut().enumerate() {
            *b = block[i % 32];
        }
        Ok(())
    }

    fn sleep_ms(&self, ms: u64) {
        self.sleeps.borrow_mut().push(ms);
    }

    fn env(&self, name: &str) -> Option<String> {
        self.env.iter().find(|(k, _)| *k == name).map(|(_, v)| v.clone())
    }
}

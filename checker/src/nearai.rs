//! NEAR AI Cloud client: the attested model key, chat completions with the exact body sent, the
//! chat's response signature, and its ed25519 check. Mirrors `apps/agent/src/nearai.ts`.

use crate::{encode_uri_component, Host, HttpRequest, HttpResponse, Method, Result};
use ed25519_dalek::{Signature as EdSignature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const NEAR_AI: &str = "https://cloud-api.near.ai/v1";

/// How often, and how long apart, a signature lookup is retried: a lookup can land on another
/// TEE node than the one that served the chat at first.
const SIGNATURE_ATTEMPTS: u64 = 6;
const SIGNATURE_BACKOFF_MS: u64 = 700;

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `GET /v1/signature/{chat_id}` as NEAR AI returns it.
#[derive(Clone, Debug, Deserialize)]
pub struct Signature {
    pub text: String,
    pub signature: String,
    #[serde(default)]
    pub signing_address: Option<String>,
    pub signing_algo: String,
}

#[derive(Debug, Deserialize)]
pub struct ChatResponse {
    pub id: String,
    #[serde(default)]
    pub choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
pub struct Choice {
    pub message: Message,
}

#[derive(Debug, Deserialize)]
pub struct Message {
    #[serde(default)]
    pub content: Option<String>,
}

pub struct Chat {
    pub response: ChatResponse,
    pub request_hash: String,
    pub response_hash: String,
}

pub struct NearAi<'a> {
    host: &'a dyn Host,
    api_key: String,
}

impl<'a> NearAi<'a> {
    pub fn new(host: &'a dyn Host, api_key: String) -> Self {
        Self { host, api_key }
    }

    fn get(&self, url: String) -> Result<HttpResponse> {
        self.host.http(&HttpRequest {
            method: Method::Get,
            url,
            headers: vec![
                ("authorization".into(), format!("Bearer {}", self.api_key)),
                ("content-type".into(), "application/json".into()),
            ],
            body: None,
        })
    }

    /// The attested model's ed25519 public key (hex, no `0x`) used for end-to-end encryption.
    pub fn model_key(&self, model: &str) -> Result<String> {
        let mut nonce = [0u8; 32];
        self.host.random(&mut nonce)?;
        let res = self.get(format!(
            "{NEAR_AI}/attestation/report?model={}&signing_algo=ed25519&nonce={}",
            encode_uri_component(model),
            hex::encode(nonce)
        ))?;
        if !res.ok() {
            return Err(format!("attestation report answered {}", res.status));
        }
        #[derive(Deserialize)]
        struct Attestation {
            signing_public_key: Option<String>,
        }
        #[derive(Deserialize)]
        struct Report {
            #[serde(default)]
            model_attestations: Vec<Attestation>,
            signing_public_key: Option<String>,
        }
        let report: Report =
            serde_json::from_slice(&res.body).map_err(|e| format!("attestation report: {e}"))?;
        let key = report
            .model_attestations
            .into_iter()
            .next()
            .and_then(|a| a.signing_public_key)
            .or(report.signing_public_key)
            .ok_or("the attestation report has no ed25519 signing key")?;
        let key = key.strip_prefix("0x").unwrap_or(&key).to_string();
        if key.len() != 64 || !key.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("the attestation report's signing key is not an ed25519 key".into());
        }
        Ok(key)
    }

    /// Sends exactly `body` and returns the parsed response with the hashes of both bodies.
    pub fn chat_raw(&self, body: &str, extra_headers: &[(&str, String)]) -> Result<Chat> {
        let mut headers = vec![
            ("authorization".to_string(), format!("Bearer {}", self.api_key)),
            ("content-type".to_string(), "application/json".to_string()),
        ];
        headers.extend(extra_headers.iter().map(|(k, v)| (k.to_string(), v.clone())));
        let res = self.host.http(&HttpRequest {
            method: Method::Post,
            url: format!("{NEAR_AI}/chat/completions"),
            headers,
            body: Some(body.as_bytes().to_vec()),
        })?;
        if !res.ok() {
            let text = res.text();
            return Err(format!(
                "NEAR AI answered {}: {}",
                res.status,
                text.chars().take(300).collect::<String>()
            ));
        }
        let response: ChatResponse =
            serde_json::from_slice(&res.body).map_err(|e| format!("NEAR AI response: {e}"))?;
        Ok(Chat { response, request_hash: sha256_hex(body.as_bytes()), response_hash: sha256_hex(&res.body) })
    }

    /// The chat's ed25519 signature, retried while the lookup lands on another node.
    pub fn signature(&self, chat_id: &str, model: &str) -> Result<Signature> {
        let url = format!(
            "{NEAR_AI}/signature/{}?model={}&signing_algo=ed25519",
            encode_uri_component(chat_id),
            encode_uri_component(model)
        );
        let mut last = String::new();
        for i in 0..SIGNATURE_ATTEMPTS {
            let res = self.get(url.clone())?;
            if res.ok() {
                return serde_json::from_slice(&res.body).map_err(|e| format!("NEAR AI signature: {e}"));
            }
            last = format!("{} {}", res.status, res.text());
            if i + 1 < SIGNATURE_ATTEMPTS {
                self.host.sleep_ms(SIGNATURE_BACKOFF_MS * (i + 1));
            }
        }
        Err(format!("no signature for chat {chat_id}: {}", last.chars().take(200).collect::<String>()))
    }
}

/// The parts of a signed text: `[model:]request_hash:response_hash` (the last two `:` fields).
#[derive(Debug, PartialEq, Eq)]
pub struct SignedHashes {
    pub model: Option<String>,
    pub request_hash: String,
    pub response_hash: String,
}

pub fn signed_hashes(text: &str) -> SignedHashes {
    let mut parts: Vec<&str> = text.split(':').collect();
    let response_hash = parts.pop().unwrap_or_default().to_string();
    let request_hash = parts.pop().unwrap_or_default().to_string();
    let model = (!parts.is_empty()).then(|| parts.join(":"));
    SignedHashes { model, request_hash, response_hash }
}

/// Checks an ed25519 NEAR AI signature over `sig.text` against the attested key (hex).
pub fn verify_ed25519(sig: &Signature, key_hex: &str) -> bool {
    if sig.signing_algo != "ed25519" {
        return false;
    }
    let strip = |s: &str| s.strip_prefix("0x").unwrap_or(s).to_string();
    let (Some(key), Some(signature)) = (
        hex::decode(strip(key_hex)).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()),
        hex::decode(strip(&sig.signature)).ok().and_then(|b| <[u8; 64]>::try_from(b).ok()),
    ) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key) else {
        return false;
    };
    key.verify(sig.text.as_bytes(), &EdSignature::from_bytes(&signature)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_signed_texts_like_the_agent() {
        assert_eq!(
            signed_hashes("a/b:1:2"),
            SignedHashes { model: Some("a/b".into()), request_hash: "1".into(), response_hash: "2".into() }
        );
        assert_eq!(signed_hashes("1:2").model, None);
        assert_eq!(signed_hashes("org:model:v2:1:2").model.as_deref(), Some("org:model:v2"));
    }
}

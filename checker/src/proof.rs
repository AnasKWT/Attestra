//! The subject's consent, checked inside the TEE before anything is signed.
//!
//! A private check attests a fact about one NEAR account, so that account must ask for it: its
//! key signs a NEP-413 message naming the rule, the subject, the hash of the exact (encrypted)
//! evidence, the GitHub login if any, and a deadline, for the verdicts contract as recipient.
//! The checker verifies the signature and that the key is a full-access key of the subject (read
//! from NEAR RPC at fixed URLs, or the key an implicit account is made of). Without it, one
//! person's evidence could mark any account.
//!
//! GitHub rules also need the login's owner to agree: a public gist of that login with a file
//! `attestra.txt` containing the line `attestra:<subject>`. The login itself never goes on chain.

use crate::check::{CheckInput, Network};
use crate::{Host, HttpRequest, Method, Result};
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// 2^31 + 413, the NEP-413 tag.
pub const NEP413_TAG: u32 = 2_147_484_061;
/// The longest a signed request may stay valid.
pub const MAX_PROOF_AGE_SECS: u64 = 86_400;
/// The file a GitHub ownership gist carries.
pub const GIST_FILE: &str = "attestra.txt";

/// What the subject's key signed (`signPrivateCheck` in the SDK builds it).
#[derive(Clone, Debug, Deserialize, serde::Serialize)]
pub struct SubjectProof {
    /// The exact JSON text the key signed.
    pub message: String,
    /// 32 bytes, base64.
    pub nonce: String,
    /// `ed25519:<base58>`.
    pub public_key: String,
    /// 64 bytes, base64.
    pub signature: String,
}

#[derive(Deserialize)]
struct Message {
    action: String,
    rule_id: String,
    subject: String,
    evidence_sha256: String,
    #[serde(default)]
    github: Option<String>,
    deadline: u64,
}

/// SHA-256 of the NEP-413 Borsh payload `(tag, message, nonce, recipient, callback_url: None)`.
pub fn nep413_hash(message: &str, nonce: &[u8; 32], recipient: &str) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(4 + 4 + message.len() + 32 + 4 + recipient.len() + 1);
    bytes.extend_from_slice(&NEP413_TAG.to_le_bytes());
    bytes.extend_from_slice(&(message.len() as u32).to_le_bytes());
    bytes.extend_from_slice(message.as_bytes());
    bytes.extend_from_slice(nonce);
    bytes.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    bytes.extend_from_slice(recipient.as_bytes());
    bytes.push(0);
    Sha256::digest(bytes).into()
}

/// The hash a proof names for the evidence: SHA-256 of the evidence field as sent (hex).
pub fn evidence_sha256(encrypted_evidence: &str) -> String {
    hex::encode(Sha256::digest(encrypted_evidence.as_bytes()))
}

fn is_implicit(account: &str) -> bool {
    account.len() == 64 && account.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_near_account(account: &str) -> bool {
    (2..=64).contains(&account.len())
        && !account.starts_with(['.', '-', '_'])
        && account.bytes().all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_'))
}

/// Checks the proof against the request: the message, the deadline, the signature and that the
/// key belongs to the subject.
pub fn verify_subject(host: &dyn Host, net: &Network, input: &CheckInput) -> Result<()> {
    if !is_near_account(&input.subject) {
        return Err("a private check is about a NEAR account".into());
    }
    let proof = input.subject_proof.as_ref().ok_or("the subject must sign the request (subject_proof)")?;
    let m: Message = serde_json::from_str(&proof.message).map_err(|_| "the signed message is not a private check request")?;
    if m.action != "private_check" {
        return Err("the signed message is not a private check request".into());
    }
    if m.rule_id != input.rule_id || m.subject != input.subject {
        return Err("the signed message names another rule or subject".into());
    }
    if m.evidence_sha256 != evidence_sha256(&input.encrypted_evidence) {
        return Err("the signed message names other evidence".into());
    }
    if m.github.as_deref().filter(|g| !g.is_empty()) != input.github.as_deref().filter(|g| !g.is_empty()) {
        return Err("the signed message names another GitHub login".into());
    }
    let now = host.now_secs();
    if m.deadline < now {
        return Err("the signed request has expired".into());
    }
    if m.deadline > now + MAX_PROOF_AGE_SECS {
        return Err("the signed request is valid for more than a day".into());
    }

    let key_b58 = proof.public_key.strip_prefix("ed25519:").ok_or("the subject key must be ed25519")?;
    let key: [u8; 32] = bs58::decode(key_b58)
        .into_vec()
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("the subject key is not 32 bytes")?;
    let b64 = base64::engine::general_purpose::STANDARD;
    let nonce: [u8; 32] =
        b64.decode(&proof.nonce).ok().and_then(|b| b.try_into().ok()).ok_or("the nonce must be 32 bytes")?;
    let sig: [u8; 64] = b64
        .decode(&proof.signature)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("the signature must be 64 bytes")?;
    let verifying = VerifyingKey::from_bytes(&key).map_err(|_| "invalid subject key")?;
    verifying
        .verify(&nep413_hash(&proof.message, &nonce, net.verdicts), &Signature::from_bytes(&sig))
        .map_err(|_| "the subject's signature does not verify")?;

    if is_implicit(&input.subject) {
        if hex::encode(key) != input.subject {
            return Err("the key is not the one this implicit account is made of".into());
        }
        return Ok(());
    }
    if !full_access_key(host, net, &input.subject, &proof.public_key)? {
        return Err(format!("{} is not a full-access key of {}", proof.public_key, input.subject));
    }
    Ok(())
}

/// Whether `public_key` is a full-access key of `account`, read from NEAR RPC (final).
fn full_access_key(host: &dyn Host, net: &Network, account: &str, public_key: &str) -> Result<bool> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": "attestra-checker",
        "method": "query",
        "params": { "request_type": "view_access_key", "finality": "final", "account_id": account, "public_key": public_key },
    })
    .to_string();
    let mut last = String::new();
    for url in net.rpc_urls {
        let res = host.http(&HttpRequest {
            method: Method::Post,
            url: url.to_string(),
            headers: vec![("content-type".into(), "application/json".into())],
            body: Some(body.as_bytes().to_vec()),
        });
        let res = match res {
            Ok(r) if r.ok() => r,
            Ok(r) => {
                last = format!("{url} answered {}", r.status);
                continue;
            }
            Err(e) => {
                last = e;
                continue;
            }
        };
        let v: Value = serde_json::from_slice(&res.body).map_err(|e| format!("RPC answer: {e}"))?;
        if let Some(result) = v.get("result") {
            if result.get("error").is_some() {
                return Ok(false);
            }
            return Ok(result.get("permission").and_then(Value::as_str) == Some("FullAccess"));
        }
        // An unknown key or account is an answer, not an outage.
        let cause = v.pointer("/error/cause/name").and_then(Value::as_str).unwrap_or("");
        if matches!(cause, "UNKNOWN_ACCESS_KEY" | "UNKNOWN_ACCOUNT" | "INVALID_ACCOUNT") {
            return Ok(false);
        }
        last = format!("{url}: {cause}");
    }
    Err(format!("could not read the subject's keys: {last}"))
}

#[derive(Deserialize)]
struct Gist {
    files: std::collections::BTreeMap<String, GistFile>,
}

#[derive(Deserialize)]
struct GistFile {
    raw_url: String,
}

/// Whether `login` published a gist file `attestra.txt` with the line `attestra:<subject>`.
pub fn github_owner_agrees(host: &dyn Host, login: &str, subject: &str, token: Option<&str>) -> Result<()> {
    let mut headers = vec![
        ("accept".to_string(), "application/vnd.github+json".to_string()),
        ("user-agent".to_string(), "attestra-checker".to_string()),
    ];
    if let Some(t) = token {
        headers.push(("authorization".into(), format!("Bearer {t}")));
    }
    let res = host.http(&HttpRequest {
        method: Method::Get,
        url: format!("https://api.github.com/users/{login}/gists?per_page=100"),
        headers: headers.clone(),
        body: None,
    })?;
    if !res.ok() {
        return Err(format!("GitHub answered {} for the gists of {login}", res.status));
    }
    let gists: Vec<Gist> = serde_json::from_slice(&res.body).map_err(|e| format!("GitHub gists: {e}"))?;
    let wanted = format!("attestra:{subject}");
    for file in gists.iter().filter_map(|g| g.files.get(GIST_FILE)) {
        // Only GitHub's own raw host, so the answer cannot come from somewhere the caller chose.
        if !file.raw_url.starts_with("https://gist.githubusercontent.com/") {
            continue;
        }
        let raw = host.http(&HttpRequest {
            method: Method::Get,
            url: file.raw_url.clone(),
            headers: vec![("user-agent".into(), "attestra-checker".into())],
            body: None,
        })?;
        if raw.ok() && String::from_utf8_lossy(&raw.body).lines().any(|l| l.trim() == wanted) {
            return Ok(());
        }
    }
    Err(format!("{login} has no public gist {GIST_FILE} with the line {wanted}"))
}

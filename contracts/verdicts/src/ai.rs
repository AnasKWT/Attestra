//! AI-checked facts: an enclave's signed verdict, backed by a NEAR AI signature over the request.

use crate::*;
use attestra_common::events::{self, emit};
use attestra_common::{is_valid_subject, now_secs};
use near_sdk::borsh;
use near_sdk::serde_json::json;

pub const VERDICT_TAG: &str = "attestra:verdict:v1";
/// How old a verdict may be when it is submitted.
pub const MAX_VERDICT_AGE_SECS: u64 = 15 * 60;
/// How far in the future `issued_at` may be (clock skew).
pub const MAX_CLOCK_SKEW_SECS: u64 = 60;
const MAX_NEARAI_TEXT_LEN: usize = 1024;

/// What the enclave signs. Times are unix seconds; `expires_at` is 0 for no expiry.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiVerdict {
    /// Unique per check; a request id is accepted once.
    pub request_id: Uid,
    pub rule_id: String,
    /// A NEAR account id or a CAIP-10 account id.
    pub subject: String,
    pub result: bool,
    /// SHA-256 of the exact NEAR AI request body.
    pub evidence_hash: Uid,
    pub model: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

/// The NEAR AI chat signature as `GET /v1/signature/{chat_id}` returns it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NearAiProof {
    /// `{model}:{request_hash}:{response_hash}` or `{request_hash}:{response_hash}`.
    pub text: String,
    /// Hex, optional `0x`: 64 bytes for ed25519, 65 bytes (`r || s || v`) for ecdsa.
    pub signature: String,
    /// `ed25519` or `ecdsa`.
    pub algo: String,
    /// The 64-hex ed25519 public key or the `0x` address that signed.
    pub key: String,
}

/// `sha256(borsh(("attestra:verdict:v1", request_id, rule_id, subject, result, evidence_hash,
/// model, issued_at, expires_at)))`, the 32 bytes the enclave's ed25519 key signs.
pub fn verdict_digest(v: &AiVerdict) -> [u8; 32] {
    let bytes = borsh::to_vec(&(
        VERDICT_TAG,
        &v.request_id.0,
        &v.rule_id,
        &v.subject,
        v.result,
        &v.evidence_hash.0,
        &v.model,
        v.issued_at,
        v.expires_at,
    ))
    .expect("borsh");
    env::sha256_array(&bytes)
}

/// The canonical form of a NEAR AI key: 64 lowercase hex characters for ed25519, `0x` and 40
/// lowercase hex characters for ecdsa. None when the key or algorithm is invalid.
pub(crate) fn normalize_model_key(algo: &str, key: &str) -> Option<String> {
    let bare = key.strip_prefix("0x").unwrap_or(key);
    let all_hex = bare.bytes().all(|c| c.is_ascii_hexdigit());
    match algo {
        "ed25519" if bare.len() == 64 && all_hex => Some(bare.to_ascii_lowercase()),
        "ecdsa" if key.starts_with("0x") && bare.len() == 40 && all_hex => {
            Some(format!("0x{}", bare.to_ascii_lowercase()))
        }
        _ => None,
    }
}

#[near]
impl Contract {
    /// Accepts an AI check signed by an allowlisted enclave and backed by a NEAR AI signature.
    /// A pass is attested under the `ai_check` schema (attach 300 TGas); a fail only marks the
    /// request id used and returns `not_attested`.
    pub fn submit_ai_verdict(
        &mut self,
        verdict: AiVerdict,
        enclave_key: PublicKey,
        enclave_signature: Base64VecU8,
        nearai: NearAiProof,
    ) -> PromiseOrValue<Outcome> {
        let schema_uid = self.schemas().ai_check;
        require_gas();
        let claim = self.check_verdict(&verdict);
        self.check_enclave(&verdict, &enclave_key, &enclave_signature.0);
        self.check_nearai(&verdict, &nearai);

        self.used_requests.insert(verdict.request_id);
        emit(
            events::VERDICT_ACCEPTED,
            &json!({
                "request_id": verdict.request_id, "rule_id": verdict.rule_id, "subject": verdict.subject,
                "result": verdict.result, "evidence_hash": verdict.evidence_hash, "model": verdict.model,
                "issued_at": verdict.issued_at, "expires_at": verdict.expires_at,
                "enclave_key": enclave_key, "nearai_key": nearai.key,
            }),
        );
        if !verdict.result {
            return PromiseOrValue::Value(Outcome::new(verdict.request_id, "not_attested"));
        }
        let data = borsh::to_vec(&(
            &verdict.rule_id,
            &claim,
            verdict.result,
            &verdict.evidence_hash.0,
            &verdict.model,
            &verdict.request_id.0,
            verdict.issued_at,
        ))
        .expect("borsh");
        let expiration = (verdict.expires_at != 0).then_some(verdict.expires_at);
        PromiseOrValue::Promise(self.attest(schema_uid, verdict.subject, data, expiration))
    }
}

impl Contract {
    /// Replay, rule, subject and time checks. Returns the rule's claim.
    fn check_verdict(&self, v: &AiVerdict) -> String {
        require!(!self.used_requests.contains(&v.request_id), "this request id was already used");
        let rule = self
            .rules
            .iter()
            .find(|r| r.id == v.rule_id)
            .unwrap_or_else(|| env::panic_str(&format!("unknown rule {}", v.rule_id)));
        require!(rule.enabled, format!("rule {} is disabled", v.rule_id));
        require!(is_valid_subject(&v.subject), "subject must be a NEAR account id or a CAIP-10 account id");
        require!(!v.model.is_empty() && v.model.len() <= MAX_MODEL_LEN, "invalid model name");
        let now = now_secs();
        require!(v.issued_at <= now + MAX_CLOCK_SKEW_SECS, "issued_at is in the future");
        require!(
            v.issued_at.saturating_add(MAX_VERDICT_AGE_SECS) >= now,
            "the verdict is older than 15 minutes"
        );
        require!(v.expires_at == 0 || v.expires_at > now, "expires_at must be 0 or in the future");
        rule.claim.clone()
    }

    fn check_enclave(&self, v: &AiVerdict, key: &PublicKey, signature: &[u8]) {
        require!(key.curve_type() == CurveType::ED25519, "the enclave key must be ed25519");
        require!(self.enclave_keys.contains(key), "unknown enclave key");
        let signature: [u8; 64] =
            signature.try_into().unwrap_or_else(|_| env::panic_str("the enclave signature must be 64 bytes"));
        let key_bytes: [u8; 32] = key.as_bytes()[1..].try_into().expect("ed25519 key");
        require!(env::ed25519_verify(&signature, verdict_digest(v), &key_bytes), "invalid enclave signature");
    }

    fn check_nearai(&self, v: &AiVerdict, p: &NearAiProof) {
        let key = normalize_model_key(&p.algo, &p.key)
            .unwrap_or_else(|| env::panic_str("the NEAR AI algo must be ed25519 or ecdsa with a valid key"));
        require!(
            self.model_signers.iter().any(|s| s.model == v.model && s.algo == p.algo && s.key == key),
            format!("the NEAR AI key is not a signer of model {}", v.model)
        );
        require!(p.text.len() <= MAX_NEARAI_TEXT_LEN, "the NEAR AI text is too long");
        let mut parts = p.text.rsplitn(3, ':');
        let (Some(_response_hash), Some(request_hash)) = (parts.next(), parts.next()) else {
            env::panic_str("the NEAR AI text must be [model:]request_hash:response_hash");
        };
        require!(
            request_hash.eq_ignore_ascii_case(&v.evidence_hash.to_hex()),
            "the NEAR AI request hash does not match evidence_hash"
        );
        let signature = crypto::decode_hex(&p.signature)
            .unwrap_or_else(|| env::panic_str("the NEAR AI signature must be hex"));
        let valid = match p.algo.as_str() {
            "ed25519" => {
                let sig: [u8; 64] = signature
                    .as_slice()
                    .try_into()
                    .unwrap_or_else(|_| env::panic_str("an ed25519 NEAR AI signature is 64 bytes"));
                let pk: [u8; 32] = crypto::decode_hex_array(&key).expect("normalized");
                env::ed25519_verify(&sig, p.text.as_bytes(), &pk)
            }
            _ => {
                require!(signature.len() == 65, "an ecdsa NEAR AI signature is 65 bytes");
                let address = crypto::parse_eth_address(&key).expect("normalized");
                crypto::recover_personal_sign(p.text.as_bytes(), &signature) == Some(address)
            }
        };
        require!(valid, "invalid NEAR AI signature");
    }
}

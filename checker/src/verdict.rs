//! The verdict the verdicts contract accepts (`contracts/verdicts/src/ai.rs`) and its digest.

use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const VERDICT_TAG: &str = "attestra:verdict:v1";

/// What the checker signs. Times are unix seconds. Field names and JSON shape match `AiVerdict`
/// in the contract and the SDK.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiVerdict {
    /// 64 lowercase hex characters, unique per check.
    pub request_id: String,
    pub rule_id: String,
    pub subject: String,
    pub result: bool,
    /// SHA-256 (hex) of the exact NEAR AI request body.
    pub evidence_hash: String,
    pub model: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

pub(crate) fn uid_bytes(hex_uid: &str, what: &str) -> Result<[u8; 32]> {
    let bare = hex_uid.strip_prefix("0x").unwrap_or(hex_uid);
    hex::decode(bare)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| format!("{what} must be 64 hex characters"))
}

/// `sha256(borsh(("attestra:verdict:v1", request_id, rule_id, subject, result, evidence_hash,
/// model, issued_at, expires_at)))`, the 32 bytes the checker key signs.
pub fn verdict_digest(v: &AiVerdict) -> Result<[u8; 32]> {
    let bytes = borsh::to_vec(&(
        VERDICT_TAG,
        uid_bytes(&v.request_id, "request_id")?,
        &v.rule_id,
        &v.subject,
        v.result,
        uid_bytes(&v.evidence_hash, "evidence_hash")?,
        &v.model,
        v.issued_at,
        v.expires_at,
    ))
    .map_err(|e| e.to_string())?;
    Ok(Sha256::digest(bytes).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vector shared with `contracts/verdicts/src/tests.rs` and `packages/sdk/test/verdicts.test.ts`.
    #[test]
    fn digest_matches_the_contract_vector() {
        let v = AiVerdict {
            request_id: "0a".repeat(32),
            rule_id: "age_over_18".into(),
            subject: "alice.testnet".into(),
            result: true,
            evidence_hash: "0e".repeat(32),
            model: "Qwen/Qwen3.5-122B-A10B".into(),
            issued_at: 1_699_999_970,
            expires_at: 1_700_086_400,
        };
        assert_eq!(
            hex::encode(verdict_digest(&v).unwrap()),
            "5bbe4290afcb5f87dfc7112c0e23723ad1795147d001fa3c60e17df80c59a26e"
        );
        let mut other = v.clone();
        other.result = false;
        assert_ne!(verdict_digest(&other).unwrap(), verdict_digest(&v).unwrap());
        other.request_id = "0x".to_string() + &"0A".repeat(32);
        other.result = true;
        assert_eq!(verdict_digest(&other).unwrap(), verdict_digest(&v).unwrap());
        other.request_id = "zz".into();
        assert!(verdict_digest(&other).is_err());
    }
}

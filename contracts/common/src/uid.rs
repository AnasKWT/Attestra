//! 32-byte identifiers and the deterministic UID derivations.
//!
//! Every UID is SHA-256 over the Borsh encoding of a tuple that starts with a domain tag, so a
//! schema UID can never equal an attestation UID. In JSON a UID is 64 lowercase hex characters.
//! The SDK's `computeSchemaUid` and `computeAttestationUid` reproduce these bytes exactly.

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use near_sdk::{env, AccountId};

pub const SCHEMA_TAG: &str = "attestra:schema:v1";
pub const ATTESTATION_TAG: &str = "attestra:attestation:v1";

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Uid(pub [u8; 32]);

impl Uid {
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    pub fn from_hex(s: &str) -> Option<Self> {
        let s = s.strip_prefix("0x").unwrap_or(s);
        if s.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        hex::decode_to_slice(s, &mut out).ok()?;
        Some(Uid(out))
    }

    pub fn sha256(bytes: &[u8]) -> Self {
        let digest = env::sha256_array(bytes);
        Uid(digest)
    }
}

impl std::fmt::Display for Uid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl Serialize for Uid {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Uid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = <String as Deserialize>::deserialize(deserializer)?;
        Uid::from_hex(&s).ok_or_else(|| de::Error::custom("expected 64 hex characters"))
    }
}

/// `sha256(borsh(("attestra:schema:v1", definition, resolver, revocable)))`
pub fn schema_uid(definition: &str, resolver: &Option<AccountId>, revocable: bool) -> Uid {
    let bytes = borsh::to_vec(&(SCHEMA_TAG, definition, resolver, revocable)).expect("borsh");
    Uid::sha256(&bytes)
}

/// `sha256(borsh(("attestra:attestation:v1", schema_uid, subject, attester, data, nonce)))`
pub fn attestation_uid(
    schema_uid: &Uid,
    subject: &str,
    attester: &AccountId,
    data: &[u8],
    nonce: u64,
) -> Uid {
    let bytes =
        borsh::to_vec(&(ATTESTATION_TAG, &schema_uid.0, subject, attester, data, nonce)).expect("borsh");
    Uid::sha256(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip() {
        let uid = Uid([7u8; 32]);
        let json = near_sdk::serde_json::to_string(&uid).unwrap();
        assert_eq!(json, format!("\"{}\"", "07".repeat(32)));
        let back: Uid = near_sdk::serde_json::from_str(&json).unwrap();
        assert_eq!(back, uid);
        assert!(Uid::from_hex("abc").is_none());
        assert_eq!(Uid::from_hex(&format!("0x{}", "07".repeat(32))), Some(uid));
    }

    /// Fixed vectors shared with the SDK's uid tests (packages/sdk/test/uid.test.ts).
    #[test]
    fn vectors() {
        let s = schema_uid("string name, u8 level", &None, true);
        assert_eq!(s.to_hex(), SCHEMA_VECTOR);
        let r: AccountId = "whitelist.attestra.testnet".parse().unwrap();
        let s2 = schema_uid("string name, u8 level", &Some(r), false);
        assert_ne!(s, s2);
        let a = attestation_uid(&s, "bob.testnet", &"alice.testnet".parse().unwrap(), &[1, 2, 3], 0);
        let b = attestation_uid(&s, "bob.testnet", &"alice.testnet".parse().unwrap(), &[1, 2, 3], 1);
        assert_ne!(a, b);
        assert_eq!(a.to_hex(), ATTESTATION_VECTOR);
    }

    const SCHEMA_VECTOR: &str = "b7707f26a2b3f1bd97ad1c8919f9c78e47031eb71092bdc441ed441110b8f452";
    const ATTESTATION_VECTOR: &str = "25619991e2f806fb62df932cd5c230a6595655c085a9a09716cc5e8702f63ede";
}

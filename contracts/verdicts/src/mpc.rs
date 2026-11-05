//! The parts of the NEAR MPC contract's foreign-transaction interface this contract uses.
//!
//! Types mirror `crates/near-mpc-contract-interface/src/types/foreign_chain.rs` and the signature
//! types of `near-mpc-crypto-types` (github.com/near/mpc, tag 3.18.0) for the EVM chains only.
//! Borsh layouts are byte-identical to the MPC's: enum indexes are pinned with explicit
//! discriminants, so `expected_payload_hash` here equals the hash the MPC network signs. JSON
//! matches what the MPC contract accepts and returns: externally tagged enums, hex without `0x`
//! for fixed-size byte arrays, `payload_version` as a number.

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::env;
use near_sdk::serde::{de, Deserialize, Deserializer, Serialize, Serializer};

/// The MPC domain whose secp256k1 key signs foreign-transaction payloads.
pub const DEFAULT_DOMAIN_ID: u64 = 3;
/// `ForeignTxPayloadVersion::V1`.
pub const PAYLOAD_VERSION_V1: u8 = 1;
/// 1 yoctoNEAR, the deposit `verify_foreign_transaction` requires.
pub const MPC_DEPOSIT_YOCTO: u128 = 1;

/// Fixed-size bytes, hex in JSON (lowercase, no prefix; `0x` is accepted on input).
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct HexArray<const N: usize>(pub [u8; N]);

pub type Hash256 = HexArray<32>;
pub type Hash160 = HexArray<20>;

impl<const N: usize> HexArray<N> {
    pub fn from_hex(s: &str) -> Option<Self> {
        let s = s.strip_prefix("0x").unwrap_or(s);
        if s.len() != 2 * N {
            return None;
        }
        let mut out = [0u8; N];
        hex::decode_to_slice(s, &mut out).ok()?;
        Some(Self(out))
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
}

impl<const N: usize> Serialize for HexArray<N> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de, const N: usize> Deserialize<'de> for HexArray<N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = <String as Deserialize>::deserialize(deserializer)?;
        Self::from_hex(&s).ok_or_else(|| de::Error::custom(format!("expected {} hex characters", 2 * N)))
    }
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub enum EvmFinality {
    Latest,
    Safe,
    Finalized,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh", use_discriminant = true)]
#[serde(crate = "near_sdk::serde")]
#[repr(u8)]
pub enum EvmExtractor {
    BlockHash = 0,
    Log { log_index: u64 } = 1,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct EvmRpcRequest {
    pub tx_id: Hash256,
    pub extractors: Vec<EvmExtractor>,
    pub finality: EvmFinality,
}

/// A log as the MPC nodes read it from `eth_getTransactionReceipt`. `data` is the RPC's string
/// exactly (`0x` followed by lowercase hex); `log_index` is the block-level log index.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct EvmLog {
    pub removed: bool,
    pub log_index: u64,
    pub transaction_index: u64,
    pub transaction_hash: Hash256,
    pub block_hash: Hash256,
    pub block_number: u64,
    pub address: Hash160,
    pub data: String,
    pub topics: Vec<Hash256>,
}

/// The EVM variants of the MPC's `ForeignChainRpcRequest`, at their indexes in that enum.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh", use_discriminant = true)]
#[serde(crate = "near_sdk::serde")]
#[repr(u8)]
pub enum ForeignChainRpcRequest {
    Ethereum(EvmRpcRequest) = 1,
    Bnb(EvmRpcRequest) = 5,
    Base(EvmRpcRequest) = 6,
    Arbitrum(EvmRpcRequest) = 7,
    Polygon(EvmRpcRequest) = 8,
    Avalanche(EvmRpcRequest) = 13,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh", use_discriminant = true)]
#[serde(crate = "near_sdk::serde")]
#[repr(u8)]
pub enum EvmExtractedValue {
    BlockHash(Hash256) = 0,
    Log(EvmLog) = 1,
}

/// The EVM variant of the MPC's `ExtractedValue`.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh", use_discriminant = true)]
#[serde(crate = "near_sdk::serde")]
#[repr(u8)]
pub enum ExtractedValue {
    EvmExtractedValue(EvmExtractedValue) = 1,
}

/// What the MPC network signs: `sha256(borsh(ForeignTxSignPayload::V1 { request, values }))`.
#[derive(BorshSerialize, Clone, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub enum ForeignTxSignPayload {
    V1 { request: ForeignChainRpcRequest, values: Vec<ExtractedValue> },
}

impl ForeignTxSignPayload {
    pub fn msg_hash(&self) -> Hash256 {
        HexArray(env::sha256_array(borsh::to_vec(self).expect("borsh")))
    }
}

/// The argument of `verify_foreign_transaction(request)`.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct VerifyForeignTransactionRequestArgs {
    pub request: ForeignChainRpcRequest,
    pub domain_id: u64,
    pub payload_version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_payload_hash: Option<Hash256>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct K256AffinePoint {
    pub affine_point: HexArray<33>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct K256Scalar {
    pub scalar: Hash256,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct K256Signature {
    pub big_r: K256AffinePoint,
    pub s: K256Scalar,
    pub recovery_id: u8,
}

impl K256Signature {
    /// `r || s` for `env::ecrecover`: `r` is the x coordinate of the compressed `big_r`.
    pub fn to_ecrecover_bytes(&self) -> [u8; 64] {
        let mut bytes = [0u8; 64];
        bytes[..32].copy_from_slice(&self.big_r.affine_point.0[1..]);
        bytes[32..].copy_from_slice(&self.s.scalar.0);
        bytes
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(crate = "near_sdk::serde", tag = "scheme")]
pub enum SignatureResponse {
    Secp256k1(K256Signature),
    Ed25519 { signature: Vec<u8> },
}

/// What `verify_foreign_transaction` resolves to.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct VerifyForeignTransactionResponse {
    pub payload_hash: Hash256,
    pub signature: SignatureResponse,
}

/// Parses an MPC public key in NEAR format, `secp256k1:<base58 of the 64-byte uncompressed key>`.
pub fn parse_secp256k1_key(s: &str) -> Option<[u8; 64]> {
    let data = s.strip_prefix("secp256k1:")?;
    near_sdk::bs58::decode(data).into_vec().ok()?.try_into().ok()
}

/// True when `signature` is the MPC key's secp256k1 signature over `hash`. Like the MPC's own
/// verifier, `ecrecover` runs with the malleability check (rejects a high `s`).
pub fn verify_secp256k1(signature: &K256Signature, hash: &[u8; 32], key: &[u8; 64]) -> bool {
    if signature.recovery_id > 3 {
        return false;
    }
    env::ecrecover(hash, &signature.to_ecrecover_bytes(), signature.recovery_id, true)
        .is_some_and(|recovered| &recovered == key)
}

/// The request and expected payload hash for one finalized log of an EVM transaction.
pub fn log_request(chain: &str, tx_id: Hash256, log: &EvmLog) -> Option<(ForeignChainRpcRequest, Hash256)> {
    let evm = EvmRpcRequest {
        tx_id,
        extractors: vec![EvmExtractor::Log { log_index: log.log_index }],
        finality: EvmFinality::Finalized,
    };
    let request = wrap(chain, evm)?;
    let payload = ForeignTxSignPayload::V1 {
        request: request.clone(),
        values: vec![ExtractedValue::EvmExtractedValue(EvmExtractedValue::Log(log.clone()))],
    };
    Some((request, payload.msg_hash()))
}

fn wrap(chain: &str, evm: EvmRpcRequest) -> Option<ForeignChainRpcRequest> {
    Some(match chain {
        "ethereum" => ForeignChainRpcRequest::Ethereum(evm),
        "bnb" => ForeignChainRpcRequest::Bnb(evm),
        "base" => ForeignChainRpcRequest::Base(evm),
        "arbitrum" => ForeignChainRpcRequest::Arbitrum(evm),
        "polygon" => ForeignChainRpcRequest::Polygon(evm),
        "avalanche" => ForeignChainRpcRequest::Avalanche(evm),
        _ => return None,
    })
}

/// The EIP-155 chain id of a chain this contract handles. The testnet MPC reads the test networks (Sepolia,
/// Base Sepolia, Arbitrum Sepolia, Polygon Amoy, BNB testnet, Avalanche Fuji).
pub fn chain_id(chain: &str, testnet: bool) -> Option<u64> {
    Some(match (chain, testnet) {
        ("ethereum", false) => 1,
        ("base", false) => 8453,
        ("arbitrum", false) => 42161,
        ("polygon", false) => 137,
        ("bnb", false) => 56,
        ("avalanche", false) => 43114,
        ("ethereum", true) => 11_155_111,
        ("base", true) => 84532,
        ("arbitrum", true) => 421_614,
        ("polygon", true) => 80002,
        ("bnb", true) => 97,
        ("avalanche", true) => 43113,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, json};

    fn h(b: u8) -> Hash256 {
        HexArray([b; 32])
    }

    /// The MPC repository's snapshot
    /// `foreign_tx_sign_payload_v1_ethereum__should_have_consistent_hash` (tag 3.18.0).
    #[test]
    fn mpc_snapshot_vector() {
        let payload = ForeignTxSignPayload::V1 {
            request: ForeignChainRpcRequest::Ethereum(EvmRpcRequest {
                tx_id: h(0xab),
                extractors: vec![EvmExtractor::BlockHash],
                finality: EvmFinality::Finalized,
            }),
            values: vec![ExtractedValue::EvmExtractedValue(EvmExtractedValue::BlockHash(h(0xef)))],
        };
        assert_eq!(
            payload.msg_hash().to_hex(),
            "2ab97999d1e015730271c7d6cbb298af76fd1de7af81926b42a8877bc4f5794e"
        );
    }

    pub fn sample_log() -> EvmLog {
        EvmLog {
            removed: false,
            log_index: 7,
            transaction_index: 3,
            transaction_hash: h(0x11),
            block_hash: h(0x22),
            block_number: 1234,
            address: HexArray([0x33; 20]),
            data: "0x0102".into(),
            topics: vec![h(0x44), h(0x55)],
        }
    }

    /// The Borsh bytes spelled out by hand, so every enum index is checked independently.
    #[test]
    fn log_payload_bytes() {
        let log = sample_log();
        let payload = ForeignTxSignPayload::V1 {
            request: ForeignChainRpcRequest::Base(EvmRpcRequest {
                tx_id: h(0x11),
                extractors: vec![EvmExtractor::Log { log_index: 7 }],
                finality: EvmFinality::Finalized,
            }),
            values: vec![ExtractedValue::EvmExtractedValue(EvmExtractedValue::Log(log.clone()))],
        };
        let mut want = vec![0u8, 6]; // V1, Base
        want.extend([0x11; 32]); // tx_id
        want.extend(1u32.to_le_bytes()); // one extractor
        want.push(1); // Log
        want.extend(7u64.to_le_bytes());
        want.push(2); // Finalized
        want.extend(1u32.to_le_bytes()); // one value
        want.extend([1, 1]); // EvmExtractedValue, Log
        want.push(0); // removed
        want.extend(7u64.to_le_bytes());
        want.extend(3u64.to_le_bytes());
        want.extend([0x11; 32]);
        want.extend([0x22; 32]);
        want.extend(1234u64.to_le_bytes());
        want.extend([0x33; 20]);
        want.extend(6u32.to_le_bytes());
        want.extend(b"0x0102");
        want.extend(2u32.to_le_bytes());
        want.extend([0x44; 32]);
        want.extend([0x55; 32]);
        assert_eq!(borsh::to_vec(&payload).unwrap(), want);

        let (request, hash) = log_request("base", h(0x11), &log).unwrap();
        assert_eq!(hash, payload.msg_hash());
        assert!(matches!(request, ForeignChainRpcRequest::Base(_)));
        assert_eq!(hash.to_hex(), LOG_PAYLOAD_VECTOR);
        assert!(log_request("solana", h(0x11), &log).is_none());
    }

    pub const LOG_PAYLOAD_VECTOR: &str = "038c130fc6cc258dd4176800f12e7f7f19f9fc36baf9884812d49a727d621499";

    #[test]
    fn request_json() {
        let (request, hash) = log_request("base", h(0x11), &sample_log()).unwrap();
        let args = VerifyForeignTransactionRequestArgs {
            request,
            domain_id: DEFAULT_DOMAIN_ID,
            payload_version: PAYLOAD_VERSION_V1,
            expected_payload_hash: Some(hash),
        };
        let v = serde_json::to_value(&args).unwrap();
        assert_eq!(
            v,
            json!({
                "request": { "Base": {
                    "tx_id": "11".repeat(32),
                    "extractors": [{ "Log": { "log_index": 7 } }],
                    "finality": "Finalized",
                }},
                "domain_id": 3,
                "payload_version": 1,
                "expected_payload_hash": hash.to_hex(),
            })
        );
        assert_eq!(serde_json::to_value(EvmExtractor::BlockHash).unwrap(), json!("BlockHash"));
        let log = serde_json::to_value(sample_log()).unwrap();
        assert_eq!(log["address"], json!("33".repeat(20)));
        assert_eq!(log["topics"][1], json!("55".repeat(32)));
        let back: EvmLog = serde_json::from_value(log).unwrap();
        assert_eq!(back, sample_log());
    }

    #[test]
    fn response_json() {
        let text = json!({
            "payload_hash": "aa".repeat(32),
            "signature": {
                "scheme": "Secp256k1",
                "big_r": { "affine_point": format!("02{}", "bb".repeat(32)) },
                "s": { "scalar": "cc".repeat(32) },
                "recovery_id": 1,
            },
        });
        let r: VerifyForeignTransactionResponse = serde_json::from_value(text.clone()).unwrap();
        assert_eq!(r.payload_hash, h(0xaa));
        let SignatureResponse::Secp256k1(sig) = &r.signature else { panic!("secp256k1") };
        assert_eq!(sig.recovery_id, 1);
        let bytes = sig.to_ecrecover_bytes();
        assert_eq!(bytes[..32], [0xbb; 32]);
        assert_eq!(bytes[32..], [0xcc; 32]);
        assert_eq!(serde_json::to_value(&r).unwrap(), text);
        assert!(HexArray::<32>::from_hex(&format!("0x{}", "AB".repeat(32))).is_some());
        assert!(HexArray::<32>::from_hex("abcd").is_none());
    }

    #[test]
    fn keys_and_chain_ids() {
        let key = "secp256k1:2KGCoy2pZt7n85QfJnQzCT1eHySuNpquUfNc8ySpRbr15F5kqU7agJYjfo5RkrzNd4tZimDFv2wAZri7RRZ32qj1";
        assert!(parse_secp256k1_key(key).is_some());
        assert!(parse_secp256k1_key("ed25519:2KGCoy2pZt7n85QfJnQzCT1eHySuNpquUfNc8y").is_none());
        assert!(parse_secp256k1_key("secp256k1:abc").is_none());
        assert_eq!(chain_id("base", false), Some(8453));
        assert_eq!(chain_id("base", true), Some(84532));
        assert_eq!(chain_id("solana", false), None);
    }
}

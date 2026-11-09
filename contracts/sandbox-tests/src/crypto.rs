//! Off-chain hashing and signing, written from the specs rather than shared with the contracts,
//! so the tests also check that the contracts derive the same bytes.

use base64::Engine;
use borsh::BorshSerialize;
use ed25519_dalek::{Signer, SigningKey};
use k256::ecdsa::SigningKey as SecpKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

pub const SCHEMA_TAG: &str = "attestra:schema:v1";
pub const ATTESTATION_TAG: &str = "attestra:attestation:v1";
pub const VERDICT_TAG: &str = "attestra:verdict:v1";
/// `2^31 + 413`, the NEP-413 prefix tag.
pub const NEP413_TAG: u32 = 2_147_484_061;

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub fn keccak256(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn from_b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).expect("base64")
}

pub fn hex32(s: &str) -> [u8; 32] {
    hex::decode(s.strip_prefix("0x").unwrap_or(s)).expect("hex").try_into().expect("32 bytes")
}

fn borsh<T: BorshSerialize>(value: &T) -> Vec<u8> {
    borsh::to_vec(value).expect("borsh")
}

// ---------------------------------------------------------------- UIDs

/// `sha256(borsh(("attestra:schema:v1", definition, resolver, revocable)))` as hex.
pub fn schema_uid(definition: &str, resolver: Option<&str>, revocable: bool) -> String {
    let resolver: Option<String> = resolver.map(str::to_string);
    hex::encode(sha256(&borsh(&(SCHEMA_TAG, definition, resolver, revocable))))
}

/// `sha256(borsh(("attestra:attestation:v1", schema_uid, subject, attester, data, nonce)))` as hex.
pub fn attestation_uid(schema_uid: &str, subject: &str, attester: &str, data: &[u8], nonce: u64) -> String {
    let schema = hex32(schema_uid);
    hex::encode(sha256(&borsh(&(ATTESTATION_TAG, schema, subject, attester, data.to_vec(), nonce))))
}

// ---------------------------------------------------------------- keys

pub fn ed_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

/// `ed25519:<base58>`, the NEAR form of an ed25519 public key.
pub fn near_public_key(key: &SigningKey) -> String {
    format!("ed25519:{}", bs58::encode(key.verifying_key().to_bytes()).into_string())
}

/// The implicit account id an ed25519 key controls: its 32 bytes as hex.
pub fn implicit_account(key: &SigningKey) -> String {
    hex::encode(key.verifying_key().to_bytes())
}

pub fn secp_key(seed: u8) -> SecpKey {
    SecpKey::from_bytes(&[seed; 32].into()).expect("valid scalar")
}

/// The 64-byte uncompressed public key, without the `04` prefix.
pub fn uncompressed(key: &SecpKey) -> [u8; 64] {
    let point = key.verifying_key().to_encoded_point(false);
    point.as_bytes()[1..].try_into().expect("64 bytes")
}

/// The lowercase `0x` Ethereum address of a secp256k1 key.
pub fn eth_address(key: &SecpKey) -> String {
    format!("0x{}", hex::encode(&keccak256(&uncompressed(key))[12..]))
}

/// `personal_sign` (EIP-191): `r || s || v` with `v` 27 or 28.
pub fn personal_sign(key: &SecpKey, text: &str) -> Vec<u8> {
    let mut message = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    message.extend_from_slice(text.as_bytes());
    let (signature, recovery) = key.sign_prehash_recoverable(&keccak256(&message)).expect("sign");
    let mut out = signature.to_bytes().to_vec();
    out.push(27 + recovery.to_byte());
    out
}

/// The MPC key in NEAR format, `secp256k1:<base58 of the 64-byte key>`.
pub fn mpc_public_key(key: &SecpKey) -> String {
    format!("secp256k1:{}", bs58::encode(uncompressed(key)).into_string())
}

/// A `SignatureResponse::Secp256k1` as the MPC contract returns it in JSON.
pub fn mpc_signature(key: &SecpKey, hash: &[u8; 32]) -> Value {
    let (signature, recovery) = key.sign_prehash_recoverable(hash).expect("sign");
    let bytes = signature.to_bytes();
    let mut big_r = vec![2 + (recovery.to_byte() & 1)];
    big_r.extend_from_slice(&bytes[..32]);
    json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": hex::encode(big_r) },
        "s": { "scalar": hex::encode(&bytes[32..]) },
        "recovery_id": recovery.to_byte(),
    })
}

// ---------------------------------------------------------------- NEP-413

#[derive(BorshSerialize)]
struct Nep413Payload {
    message: String,
    nonce: [u8; 32],
    recipient: String,
    callback_url: Option<String>,
}

/// `sha256(borsh(2^31 + 413) || borsh(Payload))`, what a wallet signs for NEP-413.
pub fn nep413_hash(
    message: &str,
    nonce: [u8; 32],
    recipient: &str,
    callback_url: Option<String>,
) -> [u8; 32] {
    let mut bytes = borsh(&NEP413_TAG);
    bytes.extend(borsh(&Nep413Payload {
        message: message.to_string(),
        nonce,
        recipient: recipient.to_string(),
        callback_url,
    }));
    sha256(&bytes)
}

/// A `SignedRequest` for `submit_signed`, signed like the SDK signs it.
pub fn signed_request(key: &SigningKey, message: &str, nonce: [u8; 32], recipient: &str) -> Value {
    let signature = key.sign(&nep413_hash(message, nonce, recipient, None));
    json!({
        "message": message,
        "nonce": b64(&nonce),
        "public_key": near_public_key(key),
        "signature": b64(&signature.to_bytes()),
        "callback_url": null,
    })
}

// ---------------------------------------------------------------- AI verdicts

#[derive(Clone, Debug)]
pub struct Verdict {
    pub request_id: [u8; 32],
    pub rule_id: String,
    pub subject: String,
    pub result: bool,
    pub evidence_hash: [u8; 32],
    pub model: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

impl Verdict {
    pub fn json(&self) -> Value {
        json!({
            "request_id": hex::encode(self.request_id),
            "rule_id": self.rule_id,
            "subject": self.subject,
            "result": self.result,
            "evidence_hash": hex::encode(self.evidence_hash),
            "model": self.model,
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
        })
    }

    /// `sha256(borsh(("attestra:verdict:v1", request_id, rule_id, subject, result, evidence_hash,
    /// model, issued_at, expires_at)))`, what the enclave signs.
    pub fn digest(&self) -> [u8; 32] {
        sha256(&borsh(&(
            VERDICT_TAG,
            self.request_id,
            &self.rule_id,
            &self.subject,
            self.result,
            self.evidence_hash,
            &self.model,
            self.issued_at,
            self.expires_at,
        )))
    }

    pub fn enclave_signature(&self, enclave: &SigningKey) -> String {
        b64(&enclave.sign(&self.digest()).to_bytes())
    }

    /// The NEAR AI text, `{model}:{request_hash}:{response_hash}`.
    pub fn nearai_text(&self) -> String {
        format!("{}:{}:{}", self.model, hex::encode(self.evidence_hash), hex::encode([0xee; 32]))
    }

    /// The attestation data the verdicts contract writes for a pass.
    pub fn attestation_data(&self, claim: &str) -> Vec<u8> {
        borsh(&(
            &self.rule_id,
            claim,
            self.result,
            self.evidence_hash,
            &self.model,
            self.request_id,
            self.issued_at,
        ))
    }
}

/// A NEAR AI proof signed with an ed25519 model key.
pub fn nearai_proof_ed25519(key: &SigningKey, text: &str) -> Value {
    json!({
        "text": text,
        "signature": hex::encode(key.sign(text.as_bytes()).to_bytes()),
        "algo": "ed25519",
        "key": hex::encode(key.verifying_key().to_bytes()),
    })
}

/// A NEAR AI proof signed with an ecdsa model key (EIP-191 over the text).
pub fn nearai_proof_ecdsa(key: &SecpKey, text: &str) -> Value {
    json!({
        "text": text,
        "signature": format!("0x{}", hex::encode(personal_sign(key, text))),
        "algo": "ecdsa",
        "key": eth_address(key),
    })
}

// ---------------------------------------------------------------- foreign events

/// An EVM log as the MPC reads it from a receipt.
#[derive(Clone, Debug)]
pub struct EvmLog {
    pub removed: bool,
    pub log_index: u64,
    pub transaction_index: u64,
    pub transaction_hash: [u8; 32],
    pub block_hash: [u8; 32],
    pub block_number: u64,
    pub address: [u8; 20],
    pub data: String,
    pub topics: Vec<[u8; 32]>,
}

impl EvmLog {
    pub fn json(&self) -> Value {
        json!({
            "removed": self.removed,
            "log_index": self.log_index,
            "transaction_index": self.transaction_index,
            "transaction_hash": hex::encode(self.transaction_hash),
            "block_hash": hex::encode(self.block_hash),
            "block_number": self.block_number,
            "address": hex::encode(self.address),
            "data": self.data,
            "topics": self.topics.iter().map(hex::encode).collect::<Vec<_>>(),
        })
    }
}

/// Index of an EVM chain in the MPC's `ForeignChainRpcRequest` enum.
pub fn mpc_chain_index(chain: &str) -> u8 {
    match chain {
        "ethereum" => 1,
        "bnb" => 5,
        "base" => 6,
        "arbitrum" => 7,
        "polygon" => 8,
        "avalanche" => 13,
        other => panic!("no MPC index for {other}"),
    }
}

/// `sha256(borsh(ForeignTxSignPayload::V1 { request, values }))` for one finalized log, with
/// every Borsh byte written out by hand.
pub fn foreign_payload_hash(chain: &str, log: &EvmLog) -> [u8; 32] {
    let mut b = vec![0u8, mpc_chain_index(chain)]; // V1, chain
    b.extend(log.transaction_hash); // tx_id
    b.extend(1u32.to_le_bytes()); // one extractor
    b.push(1); // Log
    b.extend(log.log_index.to_le_bytes());
    b.push(2); // Finalized
    b.extend(1u32.to_le_bytes()); // one value
    b.extend([1, 1]); // EvmExtractedValue, Log
    b.push(log.removed as u8);
    b.extend(log.log_index.to_le_bytes());
    b.extend(log.transaction_index.to_le_bytes());
    b.extend(log.transaction_hash);
    b.extend(log.block_hash);
    b.extend(log.block_number.to_le_bytes());
    b.extend(log.address);
    b.extend((log.data.len() as u32).to_le_bytes());
    b.extend(log.data.as_bytes());
    b.extend((log.topics.len() as u32).to_le_bytes());
    for t in &log.topics {
        b.extend(t);
    }
    sha256(&b)
}

/// The attestation data the verdicts contract writes for a foreign event.
pub fn foreign_attestation_data(chain: &str, log: &EvmLog) -> Vec<u8> {
    let data = hex::decode(log.data.strip_prefix("0x").expect("0x")).expect("hex");
    borsh(&(
        chain,
        log.transaction_hash,
        log.block_number,
        log.address.to_vec(),
        log.topics.clone(),
        data,
        log.log_index,
    ))
}

//! Attestra verdicts: facts checked off chain, attested on chain.
//!
//! This contract is an authority in the attestations contract. It verifies a fact, then calls
//! `attest` there as itself; the owner keeps a storage balance for it at the attestations contract
//! (`storage_deposit(account_id: <this contract>)`), so `attest` carries no deposit.
//!
//! Three flows:
//!
//! 1. AI-checked facts (`submit_ai_verdict`). A check runs privately in an enclave, which asks a
//!    model on NEAR AI Cloud whether a subject meets a rule (for example "is at least 18 years
//!    old") and signs a verdict with its ed25519 key. The contract checks the enclave signature
//!    against an owner-set allowlist, then the NEAR AI signature over
//!    `[model:]request_hash:response_hash` against the owner-set key of that model, and requires
//!    the request hash to equal the verdict's `evidence_hash`. A pass becomes an `ai_check`
//!    attestation; a fail is recorded only as an event.
//!    The enclave signature proves an allowlisted enclave issued this exact verdict. The NEAR AI
//!    signature proves the named model's TEE (or the NEAR AI gateway) answered a request whose
//!    body hashes to `evidence_hash`. Neither proves the evidence itself was genuine or that the
//!    model judged correctly: the enclave's code is trusted to send the real evidence and to read
//!    the answer faithfully, and the keys are trusted because the owner checked their TEE
//!    attestations before adding them. The evidence never reaches the chain.
//!
//! 2. Facts about other chains (`attest_foreign_event`). The caller names an EVM transaction and
//!    the log it expects at a log index. The contract asks the NEAR MPC network
//!    (`verify_foreign_transaction`) to read that log from finalized blocks through several RPC
//!    providers and to sign the payload hash only if the log matches. The callback checks the
//!    payload hash and the secp256k1 signature against the MPC's foreign-transaction key, then
//!    issues a `foreign_tx` attestation once per event.
//!    The signature proves the MPC network (a threshold of its nodes) saw that log in a finalized
//!    block of that chain. It does not prove anything the log does not say, and it trusts the
//!    MPC's RPC provider quorum.
//!
//! 3. Wallet links (`link_wallet`). A NEAR account proves it controls an Ethereum or Solana
//!    wallet by having the wallet sign `link_message`, which names the account and a per-account
//!    nonce. The contract verifies the signature (EIP-191 recovery or ed25519), records the link
//!    and issues a `wallet_link` attestation with the account as subject.
//!    The signature proves the wallet key holder agreed to link to this account at this nonce. It
//!    does not prove the wallet holds anything, and a later link of the same wallet replaces it.

mod ai;
mod crypto;
mod foreign;
pub mod mpc;
#[cfg(test)]
mod tests;
mod wallet;

pub use ai::{verdict_digest, AiVerdict, NearAiProof, VERDICT_TAG};
pub use foreign::ForeignEventClaim;

use attestra_common::uid::Uid;
use near_sdk::json_types::Base64VecU8;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, CurveType, Gas,
    PanicOnDefault, Promise, PromiseOrValue, PublicKey,
};

/// Gas the `attest` call gets at least; it also receives all unused gas.
pub(crate) const GAS_ATTEST: Gas = Gas::from_tgas(30);
/// Prepaid gas a call that ends in `attest` needs: enough for a schema resolver round trip at the
/// attestations contract. Attach 300 TGas.
pub(crate) const MIN_PREPAID_GAS: Gas = Gas::from_tgas(200);

const MAX_ENCLAVE_KEYS: usize = 10;
const MAX_MODEL_SIGNERS: usize = 50;
const MAX_RULES: usize = 100;
const MAX_RULE_ID_LEN: usize = 64;
const MAX_CLAIM_LEN: usize = 256;
pub(crate) const MAX_MODEL_LEN: usize = 128;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    UsedRequests,
    UsedPayloads,
    Links,
    LinkNonces,
}

/// The result of a verdict, the same shape as the attestations contract's `Outcome`. `status` is
/// one of that contract's statuses (`created`, `rejected`) or, from this contract,
/// `not_attested` (a failed AI check) or `failed` (a foreign event that could not be verified).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub uid: Uid,
    pub status: String,
}

impl Outcome {
    pub fn new(uid: Uid, status: &str) -> Self {
        Self { uid, status: status.to_string() }
    }
}

#[ext_contract(ext_attestations)]
pub trait Attestations {
    fn attest(
        &mut self,
        schema_uid: Uid,
        subject: String,
        data: Base64VecU8,
        expiration_time: Option<u64>,
        ref_uid: Option<Uid>,
    ) -> PromiseOrValue<Outcome>;
}

/// The three schemas this contract attests under.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchemaUids {
    /// `string rule_id, string claim, bool result, bytes32 evidence_hash, string model,
    /// bytes32 request_id, u64 checked_at`
    pub ai_check: Uid,
    /// `string chain, bytes32 tx_id, u64 block_number, bytes emitter, bytes32[] topics,
    /// bytes data, u64 log_index`
    pub foreign_tx: Uid,
    /// `string chain, string address, string caip10`
    pub wallet_link: Uid,
}

/// A key NEAR AI signs with for a model: `ed25519` with a 64-hex public key, or `ecdsa` with a
/// `0x`-prefixed 20-byte address.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelSigner {
    pub model: String,
    pub algo: String,
    pub key: String,
}

/// A rule an AI check decides, for example `age_over_18` / "is at least 18 years old".
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub id: String,
    pub claim: String,
    pub enabled: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub owner: AccountId,
    pub attestations: AccountId,
    pub mpc: AccountId,
    pub mpc_domain_id: u64,
    pub mpc_key: Option<String>,
    pub schemas: Option<SchemaUids>,
    pub enclave_keys: Vec<PublicKey>,
    pub model_signers: Vec<ModelSigner>,
    pub rules: Vec<Rule>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    attestations: AccountId,
    mpc: AccountId,
    mpc_domain_id: u64,
    /// `secp256k1:<base58>` as the MPC contract returns it.
    mpc_key: Option<String>,
    schemas: Option<SchemaUids>,
    enclave_keys: Vec<PublicKey>,
    model_signers: Vec<ModelSigner>,
    rules: Vec<Rule>,
    used_requests: LookupSet<Uid>,
    used_payloads: LookupSet<Uid>,
    links: LookupMap<String, AccountId>,
    link_nonces: LookupMap<AccountId, u64>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, attestations: AccountId, mpc: AccountId) -> Self {
        Self {
            owner,
            attestations,
            mpc,
            mpc_domain_id: mpc::DEFAULT_DOMAIN_ID,
            mpc_key: None,
            schemas: None,
            enclave_keys: Vec::new(),
            model_signers: Vec::new(),
            rules: Vec::new(),
            used_requests: LookupSet::new(Key::UsedRequests),
            used_payloads: LookupSet::new(Key::UsedPayloads),
            links: LookupMap::new(Key::Links),
            link_nonces: LookupMap::new(Key::LinkNonces),
        }
    }

    // ---------------------------------------------------------------- admin

    #[payable]
    pub fn set_schemas(&mut self, ai_check: Uid, foreign_tx: Uid, wallet_link: Uid) {
        self.assert_owner();
        self.schemas = Some(SchemaUids { ai_check, foreign_tx, wallet_link });
    }

    /// Replaces the ed25519 keys of the private-check enclave.
    #[payable]
    pub fn set_enclave_keys(&mut self, keys: Vec<PublicKey>) {
        self.assert_owner();
        require!(keys.len() <= MAX_ENCLAVE_KEYS, "at most 10 enclave keys");
        for (i, k) in keys.iter().enumerate() {
            require!(k.curve_type() == CurveType::ED25519, "enclave keys must be ed25519");
            require!(!keys[..i].contains(k), "duplicate enclave key");
        }
        self.enclave_keys = keys;
    }

    /// Replaces the NEAR AI signing keys. Keys are stored normalized (lowercase hex, `0x` only on
    /// addresses).
    #[payable]
    pub fn set_model_signers(&mut self, signers: Vec<ModelSigner>) {
        self.assert_owner();
        require!(signers.len() <= MAX_MODEL_SIGNERS, "at most 50 model signers");
        let mut normalized: Vec<ModelSigner> = Vec::with_capacity(signers.len());
        for s in signers {
            require!(!s.model.is_empty() && s.model.len() <= MAX_MODEL_LEN, "invalid model name");
            let key = ai::normalize_model_key(&s.algo, &s.key)
                .unwrap_or_else(|| env::panic_str(&format!("invalid {} key for model {}", s.algo, s.model)));
            let signer = ModelSigner { model: s.model, algo: s.algo, key };
            require!(!normalized.contains(&signer), "duplicate model signer");
            normalized.push(signer);
        }
        self.model_signers = normalized;
    }

    /// Sets the MPC network's foreign-transaction key, `secp256k1:<base58 of 64 bytes>` as
    /// `public_key({"domain_id": 3})` returns it, and optionally its domain (3 by default).
    #[payable]
    pub fn set_mpc_key(&mut self, public_key: String, domain_id: Option<u64>) {
        self.assert_owner();
        require!(mpc::parse_secp256k1_key(&public_key).is_some(), "expected secp256k1:<base58 of 64 bytes>");
        self.mpc_key = Some(public_key);
        if let Some(d) = domain_id {
            self.mpc_domain_id = d;
        }
    }

    /// Replaces the rules AI checks decide.
    #[payable]
    pub fn set_rules(&mut self, rules: Vec<Rule>) {
        self.assert_owner();
        require!(rules.len() <= MAX_RULES, "at most 100 rules");
        for (i, r) in rules.iter().enumerate() {
            require!(!r.id.is_empty() && r.id.len() <= MAX_RULE_ID_LEN, "rule id must be 1 to 64 bytes");
            require!(
                !r.claim.is_empty() && r.claim.len() <= MAX_CLAIM_LEN,
                "rule claim must be 1 to 256 bytes"
            );
            require!(rules[..i].iter().all(|o| o.id != r.id), "duplicate rule id");
        }
        self.rules = rules;
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            attestations: self.attestations.clone(),
            mpc: self.mpc.clone(),
            mpc_domain_id: self.mpc_domain_id,
            mpc_key: self.mpc_key.clone(),
            schemas: self.schemas.clone(),
            enclave_keys: self.enclave_keys.clone(),
            model_signers: self.model_signers.clone(),
            rules: self.rules.clone(),
        }
    }

    pub fn get_rules(&self) -> Vec<Rule> {
        self.rules.clone()
    }

    /// True when an AI check with this request id was already accepted.
    pub fn is_request_used(&self, request_id: Uid) -> bool {
        self.used_requests.contains(&request_id)
    }

    /// True when the foreign event with this MPC payload hash was already attested.
    pub fn is_event_attested(&self, payload_hash: Uid) -> bool {
        self.used_payloads.contains(&payload_hash)
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

impl Contract {
    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    pub(crate) fn schemas(&self) -> &SchemaUids {
        self.schemas.as_ref().unwrap_or_else(|| env::panic_str("schemas are not configured"))
    }

    /// The `attest` call at the attestations contract, with no deposit and all unused gas.
    pub(crate) fn attest(
        &self,
        schema_uid: Uid,
        subject: String,
        data: Vec<u8>,
        expiration_time: Option<u64>,
    ) -> near_sdk::Promise {
        ext_attestations::ext(self.attestations.clone())
            .with_static_gas(GAS_ATTEST)
            .with_unused_gas_weight(1)
            .attest(schema_uid, subject, Base64VecU8(data), expiration_time, None)
    }

    /// True when the MPC is the testnet one, so foreign chains are their test networks.
    pub(crate) fn is_testnet(&self) -> bool {
        self.mpc.as_str().ends_with(".testnet")
    }
}

pub(crate) fn require_gas() {
    require!(env::prepaid_gas() >= MIN_PREPAID_GAS, "attach at least 200 TGas (300 recommended)");
}

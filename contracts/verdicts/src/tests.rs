use super::*;
use crate::mpc::{EvmLog, HexArray, K256AffinePoint, K256Scalar, K256Signature, SignatureResponse};
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::borsh;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult, RuntimeFeesConfig};
use sha3::{Digest, Keccak256};

const T0: u64 = 1_700_000_000;
const SELF: &str = "verdicts.attestra.testnet";
const OWNER: &str = "owner.testnet";
const ATTESTATIONS: &str = "attestations.attestra.testnet";
const MPC: &str = "v1.signer-prod.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: u128, at: u64, tgas: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(SELF))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(tgas))
        .block_timestamp(at * 1_000_000_000);
    b
}

fn set(predecessor: &str, deposit: u128) {
    testing_env!(ctx(predecessor, deposit, T0, 300).build());
}

fn set_at(predecessor: &str, at: u64) {
    testing_env!(ctx(predecessor, 0, at, 300).build());
}

fn set_result(result: PromiseResult) {
    testing_env!(
        ctx(SELF, 0, T0, 300).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

// ---------------------------------------------------------------- keys

fn enclave() -> SigningKey {
    SigningKey::from_bytes(&[1; 32])
}

fn nearai_ed() -> SigningKey {
    SigningKey::from_bytes(&[2; 32])
}

fn secp(seed: u8) -> k256::ecdsa::SigningKey {
    k256::ecdsa::SigningKey::from_bytes(&[seed; 32].into()).unwrap()
}

fn near_key(k: &SigningKey) -> PublicKey {
    format!("ed25519:{}", near_sdk::bs58::encode(k.verifying_key().to_bytes()).into_string()).parse().unwrap()
}

/// The 64-byte uncompressed public key (no `04` prefix).
fn uncompressed(k: &k256::ecdsa::SigningKey) -> [u8; 64] {
    let point = k.verifying_key().to_encoded_point(false);
    point.as_bytes()[1..].try_into().unwrap()
}

fn eth_addr(k: &k256::ecdsa::SigningKey) -> String {
    let hash = Keccak256::digest(uncompressed(k));
    format!("0x{}", hex::encode(&hash[12..]))
}

/// `personal_sign`: `r || s || v` with `v` = 27 or 28.
fn personal_sign(k: &k256::ecdsa::SigningKey, text: &str) -> Vec<u8> {
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let hash = Keccak256::digest(&msg);
    let (sig, recid) = k.sign_prehash_recoverable(&hash).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(27 + recid.to_byte());
    out
}

fn mpc_key_string(k: &k256::ecdsa::SigningKey) -> String {
    format!("secp256k1:{}", near_sdk::bs58::encode(uncompressed(k)).into_string())
}

fn mpc_sign(k: &k256::ecdsa::SigningKey, hash: &[u8; 32]) -> K256Signature {
    let (sig, recid) = k.sign_prehash_recoverable(hash).unwrap();
    let bytes = sig.to_bytes();
    let mut point = [0u8; 33];
    point[0] = 2 + (recid.to_byte() & 1);
    point[1..].copy_from_slice(&bytes[..32]);
    K256Signature {
        big_r: K256AffinePoint { affine_point: HexArray(point) },
        s: K256Scalar { scalar: HexArray(bytes[32..].try_into().unwrap()) },
        recovery_id: recid.to_byte(),
    }
}

// ---------------------------------------------------------------- setup

const MODEL: &str = "Qwen/Qwen3.5-122B-A10B";

fn schema(n: u8) -> Uid {
    Uid([n; 32])
}

fn setup() -> Contract {
    set(OWNER, 0);
    let mut c = Contract::new(acc(OWNER), acc(ATTESTATIONS), acc(MPC));
    set(OWNER, 1);
    c.set_schemas(schema(1), schema(2), schema(3));
    c.set_enclave_keys(vec![near_key(&enclave())]);
    c.set_model_signers(vec![
        ModelSigner {
            model: MODEL.into(),
            algo: "ed25519".into(),
            key: hex::encode(nearai_ed().verifying_key().to_bytes()).to_uppercase(),
        },
        ModelSigner {
            model: MODEL.into(),
            algo: "ecdsa".into(),
            key: eth_addr(&secp(3)).to_uppercase().replace("0X", "0x"),
        },
    ]);
    c.set_rules(vec![
        Rule { id: "age_over_18".into(), claim: "is at least 18 years old".into(), enabled: true },
        Rule { id: "kyc".into(), claim: "passed KYC".into(), enabled: false },
    ]);
    c.set_mpc_key(mpc_key_string(&secp(4)), None);
    set("relayer.testnet", 0);
    c
}

struct Call {
    receiver: String,
    method: String,
    args: Vec<u8>,
    deposit: u128,
    gas: Gas,
    weight: u64,
}

fn calls() -> Vec<Call> {
    let mut out = Vec::new();
    for r in get_created_receipts() {
        for a in r.actions {
            if let MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                gas_weight,
                ..
            } = a
            {
                out.push(Call {
                    receiver: r.receiver_id.to_string(),
                    method: String::from_utf8(method_name).unwrap(),
                    args,
                    deposit: attached_deposit.as_yoctonear(),
                    gas: prepaid_gas,
                    weight: gas_weight.0,
                });
            }
        }
    }
    out
}

fn events(name: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|v| v["event"] == name)
        .map(|v| v["data"][0].clone())
        .collect()
}

fn value(o: PromiseOrValue<Outcome>) -> Outcome {
    match o {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

/// Drops the promise (which schedules it) and returns the `attest` call it made.
fn attest_call(o: PromiseOrValue<Outcome>) -> Value {
    assert!(matches!(o, PromiseOrValue::Promise(_)), "expected a promise");
    drop(o);
    let calls = calls();
    let attest = calls.iter().find(|c| c.method == "attest").expect("an attest call");
    assert_eq!(attest.receiver, ATTESTATIONS);
    assert_eq!(attest.deposit, 0);
    assert_eq!(attest.gas, GAS_ATTEST);
    assert_eq!(attest.weight, 1);
    serde_json::from_slice(&attest.args).unwrap()
}

fn data_of(args: &Value) -> Vec<u8> {
    near_sdk::base64::Engine::decode(
        &near_sdk::base64::engine::general_purpose::STANDARD,
        args["data"].as_str().unwrap(),
    )
    .unwrap()
}

// ---------------------------------------------------------------- admin

#[test]
fn config_and_views() {
    let c = setup();
    let cfg = c.get_config();
    assert_eq!(cfg.owner, acc(OWNER));
    assert_eq!(cfg.mpc, acc(MPC));
    assert_eq!(cfg.mpc_domain_id, 3);
    assert_eq!(cfg.schemas.unwrap().wallet_link, schema(3));
    assert_eq!(cfg.enclave_keys, vec![near_key(&enclave())]);
    assert_eq!(cfg.model_signers[0].key, hex::encode(nearai_ed().verifying_key().to_bytes()));
    assert_eq!(cfg.model_signers[1].key, eth_addr(&secp(3)));
    assert_eq!(c.get_rules().len(), 2);
    assert_eq!(c.version(), "1.0.0");
    let json = serde_json::to_value(c.get_config()).unwrap();
    assert_eq!(json["schemas"]["ai_check"], json!("01".repeat(32)));
    assert_eq!(json["mpc_key"], json!(mpc_key_string(&secp(4))));
}

#[test]
#[should_panic(expected = "only the owner")]
fn setters_are_owner_only() {
    let mut c = setup();
    set("mallory.testnet", 1);
    c.set_rules(vec![]);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn setters_need_one_yocto() {
    let mut c = setup();
    set(OWNER, 0);
    c.set_schemas(schema(1), schema(2), schema(3));
}

#[test]
#[should_panic(expected = "enclave keys must be ed25519")]
fn enclave_keys_are_ed25519() {
    let mut c = setup();
    set(OWNER, 1);
    let secp_key: PublicKey =
        format!("secp256k1:{}", near_sdk::bs58::encode(uncompressed(&secp(9))).into_string())
            .parse()
            .unwrap();
    c.set_enclave_keys(vec![secp_key]);
}

#[test]
#[should_panic(expected = "invalid ecdsa key for model m")]
fn model_signer_keys_are_checked() {
    let mut c = setup();
    set(OWNER, 1);
    c.set_model_signers(vec![ModelSigner { model: "m".into(), algo: "ecdsa".into(), key: "ab".repeat(20) }]);
}

#[test]
#[should_panic(expected = "invalid rsa key for model m")]
fn model_signer_algo_is_checked() {
    let mut c = setup();
    set(OWNER, 1);
    c.set_model_signers(vec![ModelSigner { model: "m".into(), algo: "rsa".into(), key: "ab".repeat(32) }]);
}

#[test]
#[should_panic(expected = "duplicate rule id")]
fn rules_are_unique() {
    let mut c = setup();
    set(OWNER, 1);
    let r = Rule { id: "a".into(), claim: "b".into(), enabled: true };
    c.set_rules(vec![r.clone(), r]);
}

#[test]
#[should_panic(expected = "expected secp256k1:<base58 of 64 bytes>")]
fn mpc_key_is_checked() {
    let mut c = setup();
    set(OWNER, 1);
    c.set_mpc_key("ed25519:abc".into(), None);
}

#[test]
fn mpc_key_and_domain() {
    let mut c = setup();
    set(OWNER, 1);
    let key =
        "secp256k1:2KGCoy2pZt7n85QfJnQzCT1eHySuNpquUfNc8ySpRbr15F5kqU7agJYjfo5RkrzNd4tZimDFv2wAZri7RRZ32qj1";
    c.set_mpc_key(key.into(), Some(4));
    assert_eq!(c.get_config().mpc_key.as_deref(), Some(key));
    assert_eq!(c.get_config().mpc_domain_id, 4);
}

// ---------------------------------------------------------------- AI verdicts

fn verdict(result: bool) -> AiVerdict {
    AiVerdict {
        request_id: Uid([0x0a; 32]),
        rule_id: "age_over_18".into(),
        subject: "alice.testnet".into(),
        result,
        evidence_hash: Uid([0x0e; 32]),
        model: MODEL.into(),
        issued_at: T0 - 30,
        expires_at: T0 + 86_400,
    }
}

fn enclave_sig(v: &AiVerdict) -> Base64VecU8 {
    Base64VecU8(enclave().sign(&verdict_digest(v)).to_bytes().to_vec())
}

fn nearai_text(v: &AiVerdict) -> String {
    format!("{}:{}:{}", v.model, v.evidence_hash.to_hex(), "f0".repeat(32))
}

fn proof_ed(text: &str) -> NearAiProof {
    NearAiProof {
        text: text.into(),
        signature: hex::encode(nearai_ed().sign(text.as_bytes()).to_bytes()),
        algo: "ed25519".into(),
        key: hex::encode(nearai_ed().verifying_key().to_bytes()),
    }
}

fn proof_ecdsa(text: &str) -> NearAiProof {
    NearAiProof {
        text: text.into(),
        signature: format!("0x{}", hex::encode(personal_sign(&secp(3), text))),
        algo: "ecdsa".into(),
        key: eth_addr(&secp(3)).to_uppercase().replace("0X", "0x"),
    }
}

fn submit(c: &mut Contract, v: &AiVerdict, proof: NearAiProof) -> PromiseOrValue<Outcome> {
    c.submit_ai_verdict(v.clone(), near_key(&enclave()), enclave_sig(v), proof)
}

/// Fixed vector for the TypeScript side: the `verdict()` above.
#[test]
fn verdict_digest_vector() {
    assert_eq!(hex::encode(verdict_digest(&verdict(true))), VERDICT_VECTOR);
    let mut other = verdict(true);
    other.result = false;
    assert_ne!(verdict_digest(&other), verdict_digest(&verdict(true)));
}

const VERDICT_VECTOR: &str = "5bbe4290afcb5f87dfc7112c0e23723ad1795147d001fa3c60e17df80c59a26e";

#[test]
fn pass_with_ed25519_proof_attests() {
    let mut c = setup();
    let v = verdict(true);
    let args = attest_call(submit(&mut c, &v, proof_ed(&nearai_text(&v))));
    assert_eq!(args["schema_uid"], json!(schema(1).to_hex()));
    assert_eq!(args["subject"], json!("alice.testnet"));
    assert_eq!(args["expiration_time"], json!(T0 + 86_400));
    assert_eq!(args["ref_uid"], Value::Null);
    let want = borsh::to_vec(&(
        "age_over_18",
        "is at least 18 years old",
        true,
        [0x0e_u8; 32],
        MODEL,
        [0x0a_u8; 32],
        T0 - 30,
    ))
    .unwrap();
    assert_eq!(data_of(&args), want);
    let e = events("verdict_accepted");
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["result"], json!(true));
    assert_eq!(e[0]["request_id"], json!("0a".repeat(32)));
    assert!(c.is_request_used(v.request_id));
}

#[test]
fn pass_with_ecdsa_proof_and_two_part_text() {
    let mut c = setup();
    let mut v = verdict(true);
    v.expires_at = 0;
    let text = format!("{}:{}", v.evidence_hash.to_hex().to_uppercase(), "f0".repeat(32));
    let args = attest_call(submit(&mut c, &v, proof_ecdsa(&text)));
    assert_eq!(args["expiration_time"], Value::Null);
}

#[test]
fn ecdsa_v_zero_or_one_is_accepted() {
    let mut c = setup();
    let v = verdict(true);
    let text = nearai_text(&v);
    let mut proof = proof_ecdsa(&text);
    let mut sig = personal_sign(&secp(3), &text);
    sig[64] -= 27;
    proof.signature = hex::encode(sig);
    attest_call(submit(&mut c, &v, proof));
}

#[test]
fn fail_result_is_recorded_without_attesting() {
    let mut c = setup();
    let v = verdict(false);
    let o = value(submit(&mut c, &v, proof_ed(&nearai_text(&v))));
    assert_eq!(o, Outcome::new(v.request_id, "not_attested"));
    assert!(calls().is_empty());
    assert_eq!(events("verdict_accepted")[0]["result"], json!(false));
    assert!(c.is_request_used(v.request_id));
}

#[test]
#[should_panic(expected = "this request id was already used")]
fn replay_is_rejected() {
    let mut c = setup();
    let v = verdict(false);
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
}

#[test]
#[should_panic(expected = "rule kyc is disabled")]
fn disabled_rule_is_rejected() {
    let mut c = setup();
    let mut v = verdict(true);
    v.rule_id = "kyc".into();
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
}

#[test]
#[should_panic(expected = "unknown rule nope")]
fn unknown_rule_is_rejected() {
    let mut c = setup();
    let mut v = verdict(true);
    v.rule_id = "nope".into();
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
}

#[test]
#[should_panic(expected = "subject must be a NEAR account id or a CAIP-10 account id")]
fn invalid_subject_is_rejected() {
    let mut c = setup();
    let mut v = verdict(true);
    v.subject = "Not A Subject".into();
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
}

#[test]
fn caip10_subject_is_accepted() {
    let mut c = setup();
    let mut v = verdict(true);
    v.subject = "eip155:1:0xab5801a7d398351b8be11c439e05c5b3259aec9b".into();
    let args = attest_call(submit(&mut c, &v, proof_ed(&nearai_text(&v))));
    assert_eq!(args["subject"], json!(v.subject));
}

#[test]
#[should_panic(expected = "the verdict is older than 15 minutes")]
fn stale_verdict_is_rejected() {
    let mut c = setup();
    let mut v = verdict(true);
    v.issued_at = T0 - 15 * 60 - 1;
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
}

#[test]
fn verdict_at_the_age_limit_and_within_skew_is_accepted() {
    let mut c = setup();
    let mut v = verdict(true);
    v.issued_at = T0 - 15 * 60;
    attest_call(submit(&mut c, &v, proof_ed(&nearai_text(&v))));
    set_at("relayer.testnet", T0);
    v.request_id = Uid([0x0b; 32]);
    v.issued_at = T0 + 60;
    attest_call(submit(&mut c, &v, proof_ed(&nearai_text(&v))));
}

#[test]
#[should_panic(expected = "issued_at is in the future")]
fn future_verdict_is_rejected() {
    let mut c = setup();
    let mut v = verdict(true);
    v.issued_at = T0 + 61;
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
}

#[test]
#[should_panic(expected = "expires_at must be 0 or in the future")]
fn expired_verdict_is_rejected() {
    let mut c = setup();
    let mut v = verdict(true);
    v.expires_at = T0;
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
}

#[test]
#[should_panic(expected = "unknown enclave key")]
fn unknown_enclave_key_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let other = SigningKey::from_bytes(&[7; 32]);
    let sig = Base64VecU8(other.sign(&verdict_digest(&v)).to_bytes().to_vec());
    let _ = c.submit_ai_verdict(v.clone(), near_key(&other), sig, proof_ed(&nearai_text(&v)));
}

#[test]
#[should_panic(expected = "the enclave key must be ed25519")]
fn secp256k1_enclave_key_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let key: PublicKey =
        format!("secp256k1:{}", near_sdk::bs58::encode(uncompressed(&secp(9))).into_string())
            .parse()
            .unwrap();
    let _ = c.submit_ai_verdict(v.clone(), key, enclave_sig(&v), proof_ed(&nearai_text(&v)));
}

#[test]
#[should_panic(expected = "invalid enclave signature")]
fn bad_enclave_signature_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let mut signed = v.clone();
    signed.result = false;
    let _ = c.submit_ai_verdict(
        v.clone(),
        near_key(&enclave()),
        enclave_sig(&signed),
        proof_ed(&nearai_text(&v)),
    );
}

#[test]
#[should_panic(expected = "the enclave signature must be 64 bytes")]
fn short_enclave_signature_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let _ = c.submit_ai_verdict(
        v.clone(),
        near_key(&enclave()),
        Base64VecU8(vec![0; 63]),
        proof_ed(&nearai_text(&v)),
    );
}

#[test]
#[should_panic(expected = "the NEAR AI key is not a signer of model other/model")]
fn model_key_mismatch_is_rejected() {
    let mut c = setup();
    let mut v = verdict(true);
    v.model = "other/model".into();
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
}

#[test]
#[should_panic(expected = "the NEAR AI key is not a signer of model")]
fn unknown_model_key_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let other = SigningKey::from_bytes(&[8; 32]);
    let text = nearai_text(&v);
    let proof = NearAiProof {
        text: text.clone(),
        signature: hex::encode(other.sign(text.as_bytes()).to_bytes()),
        algo: "ed25519".into(),
        key: hex::encode(other.verifying_key().to_bytes()),
    };
    let _ = submit(&mut c, &v, proof);
}

#[test]
#[should_panic(expected = "the NEAR AI key is not a signer of model")]
fn algo_mismatch_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let mut proof = proof_ecdsa(&nearai_text(&v));
    proof.algo = "ed25519".into();
    proof.key = format!("{}{}", &proof.key[2..], "00".repeat(12));
    let _ = submit(&mut c, &v, proof);
}

#[test]
#[should_panic(expected = "the NEAR AI request hash does not match evidence_hash")]
fn request_hash_mismatch_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let text = format!("{}:{}:{}", v.model, "ee".repeat(32), "f0".repeat(32));
    let _ = submit(&mut c, &v, proof_ed(&text));
}

#[test]
#[should_panic(expected = "the NEAR AI text must be [model:]request_hash:response_hash")]
fn malformed_text_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let _ = submit(&mut c, &v, proof_ed(&v.evidence_hash.to_hex()));
}

#[test]
#[should_panic(expected = "invalid NEAR AI signature")]
fn bad_ed25519_proof_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let mut proof = proof_ed(&nearai_text(&v));
    proof.text = format!("{}:{}:{}", v.model, v.evidence_hash.to_hex(), "f1".repeat(32));
    let _ = submit(&mut c, &v, proof);
}

#[test]
#[should_panic(expected = "invalid NEAR AI signature")]
fn bad_ecdsa_proof_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let text = nearai_text(&v);
    let mut proof = proof_ecdsa(&text);
    proof.signature = hex::encode(personal_sign(&secp(3), &format!("{text}x")));
    let _ = submit(&mut c, &v, proof);
}

#[test]
#[should_panic(expected = "an ecdsa NEAR AI signature is 65 bytes")]
fn short_ecdsa_proof_is_rejected() {
    let mut c = setup();
    let v = verdict(true);
    let mut proof = proof_ecdsa(&nearai_text(&v));
    proof.signature = "00".repeat(64);
    let _ = submit(&mut c, &v, proof);
}

#[test]
#[should_panic(expected = "schemas are not configured")]
fn schemas_must_be_configured() {
    set(OWNER, 0);
    let mut c = Contract::new(acc(OWNER), acc(ATTESTATIONS), acc(MPC));
    let v = verdict(true);
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
}

#[test]
#[should_panic(expected = "attach at least 200 TGas")]
fn low_gas_is_rejected() {
    let mut c = setup();
    testing_env!(ctx("relayer.testnet", 0, T0, 100).build());
    let v = verdict(true);
    let _ = submit(&mut c, &v, proof_ed(&nearai_text(&v)));
}

#[test]
fn verdict_json_shape() {
    let v: AiVerdict = serde_json::from_value(json!({
        "request_id": "0a".repeat(32), "rule_id": "age_over_18", "subject": "alice.testnet", "result": true,
        "evidence_hash": "0e".repeat(32), "model": MODEL, "issued_at": T0 - 30, "expires_at": T0 + 86_400,
    }))
    .unwrap();
    assert_eq!(v, verdict(true));
}

// ---------------------------------------------------------------- foreign events

fn tx() -> String {
    format!("0x{}", "11".repeat(32))
}

fn log() -> EvmLog {
    EvmLog {
        removed: false,
        log_index: 7,
        transaction_index: 3,
        transaction_hash: HexArray([0x11; 32]),
        block_hash: HexArray([0x22; 32]),
        block_number: 1234,
        address: HexArray([0x33; 20]),
        data: "0x0102".into(),
        topics: vec![HexArray([0x44; 32]), HexArray([0x55; 32])],
    }
}

fn claim() -> ForeignEventClaim {
    ForeignEventClaim { chain: "base".into(), tx_id: tx(), log_index: 7, log: log(), subject: None }
}

fn payload_hash(c: &ForeignEventClaim) -> mpc::Hash256 {
    mpc::log_request(&c.chain, HexArray::from_hex(&c.tx_id).unwrap(), &c.log).unwrap().1
}

fn mpc_response(hash: mpc::Hash256, signer: u8) -> PromiseResult {
    let response = mpc::VerifyForeignTransactionResponse {
        payload_hash: hash,
        signature: SignatureResponse::Secp256k1(mpc_sign(&secp(signer), &hash.0)),
    };
    PromiseResult::Successful(serde_json::to_vec(&response).unwrap())
}

#[test]
fn foreign_request_calls_the_mpc() {
    let mut c = setup();
    let claim = claim();
    let hash = payload_hash(&claim);
    let p = c.attest_foreign_event(claim.clone());
    drop(p);
    let calls = calls();
    let mpc_call = calls.iter().find(|c| c.method == "verify_foreign_transaction").unwrap();
    assert_eq!(mpc_call.receiver, MPC);
    assert_eq!(mpc_call.deposit, 1);
    assert_eq!(mpc_call.gas, Gas::from_tgas(25));
    assert_eq!(mpc_call.weight, 0);
    let args: Value = serde_json::from_slice(&mpc_call.args).unwrap();
    assert_eq!(
        args,
        json!({ "request": {
            "request": { "Base": {
                "tx_id": "11".repeat(32),
                "extractors": [{ "Log": { "log_index": 7 } }],
                "finality": "Finalized",
            }},
            "domain_id": 3,
            "payload_version": 1,
            "expected_payload_hash": hash.to_hex(),
        }})
    );
    let cb = calls.iter().find(|c| c.method == "on_foreign_verified").unwrap();
    assert_eq!(cb.receiver, SELF);
    assert_eq!(cb.gas, Gas::from_tgas(55));
    assert_eq!(cb.weight, 1);
    let cb_args: Value = serde_json::from_slice(&cb.args).unwrap();
    let back: ForeignEventClaim = serde_json::from_value(cb_args["claim"].clone()).unwrap();
    assert_eq!(back, claim);
    let e = events("foreign_tx_requested");
    assert_eq!(e[0]["payload_hash"], json!(hash.to_hex()));
    assert_eq!(e[0]["subject"], json!(format!("eip155:84532:0x{}", "33".repeat(20))));
}

#[test]
#[should_panic(expected = "unknown chain solana")]
fn foreign_unknown_chain() {
    let mut c = setup();
    let mut claim = claim();
    claim.chain = "solana".into();
    let _ = c.attest_foreign_event(claim);
}

#[test]
#[should_panic(expected = "tx_id must be 32 bytes of hex")]
fn foreign_bad_tx_id() {
    let mut c = setup();
    let mut claim = claim();
    claim.tx_id = "0x1234".into();
    let _ = c.attest_foreign_event(claim);
}

#[test]
#[should_panic(expected = "log.log_index differs from log_index")]
fn foreign_log_index_mismatch() {
    let mut c = setup();
    let mut claim = claim();
    claim.log_index = 8;
    let _ = c.attest_foreign_event(claim);
}

#[test]
#[should_panic(expected = "log.transaction_hash differs from tx_id")]
fn foreign_tx_hash_mismatch() {
    let mut c = setup();
    let mut claim = claim();
    claim.log.transaction_hash = HexArray([0x12; 32]);
    let _ = c.attest_foreign_event(claim);
}

#[test]
#[should_panic(expected = "log.data must be 0x-prefixed hex")]
fn foreign_bad_log_data() {
    let mut c = setup();
    let mut claim = claim();
    claim.log.data = "0102".into();
    let _ = c.attest_foreign_event(claim);
}

#[test]
#[should_panic(expected = "the MPC key is not configured")]
fn foreign_needs_mpc_key() {
    set(OWNER, 0);
    let mut c = Contract::new(acc(OWNER), acc(ATTESTATIONS), acc(MPC));
    set(OWNER, 1);
    c.set_schemas(schema(1), schema(2), schema(3));
    let _ = c.attest_foreign_event(claim());
}

#[test]
fn foreign_verified_attests_once() {
    let mut c = setup();
    let claim = claim();
    let hash = payload_hash(&claim);
    set_result(mpc_response(hash, 4));
    let o = c.on_foreign_verified(claim.clone());
    let args = attest_call(o);
    assert_eq!(args["schema_uid"], json!(schema(2).to_hex()));
    assert_eq!(args["subject"], json!(format!("eip155:84532:0x{}", "33".repeat(20))));
    assert_eq!(args["expiration_time"], Value::Null);
    let want = borsh::to_vec(&(
        "base",
        [0x11_u8; 32],
        1234u64,
        vec![0x33_u8; 20],
        vec![[0x44_u8; 32], [0x55_u8; 32]],
        vec![1u8, 2],
        7u64,
    ))
    .unwrap();
    assert_eq!(data_of(&args), want);
    let follow = calls().into_iter().find(|c| c.method == "on_foreign_attested").unwrap();
    assert_eq!(follow.receiver, SELF);
    assert_eq!(follow.weight, 0);
    let e = events("foreign_tx_verified");
    assert_eq!(e[0]["block_number"], json!(1234));
    assert_eq!(e[0]["emitter"], json!(format!("0x{}", "33".repeat(20))));
    assert!(c.is_event_attested(Uid(hash.0)));

    // A second answer for the same event attests nothing.
    set_result(mpc_response(hash, 4));
    let o = value(c.on_foreign_verified(claim.clone()));
    assert_eq!(o, Outcome::new(Uid(hash.0), "failed"));
    assert_eq!(events("foreign_tx_failed")[0]["reason"], json!("this event was already attested"));
}

#[test]
#[should_panic(expected = "this event was already attested")]
fn foreign_request_for_attested_event_is_rejected() {
    let mut c = setup();
    let claim = claim();
    set_result(mpc_response(payload_hash(&claim), 4));
    drop(c.on_foreign_verified(claim.clone()));
    set("relayer.testnet", 0);
    let _ = c.attest_foreign_event(claim);
}

#[test]
fn foreign_custom_subject_and_mainnet_chain_ids() {
    set(OWNER, 0);
    let mut c = Contract::new(acc(OWNER), acc(ATTESTATIONS), acc("v1.signer"));
    set(OWNER, 1);
    c.set_schemas(schema(1), schema(2), schema(3));
    c.set_mpc_key(mpc_key_string(&secp(4)), None);
    let mut claim = claim();
    claim.chain = "ethereum".into();
    set_result(mpc_response(payload_hash(&claim), 4));
    let args = attest_call(c.on_foreign_verified(claim.clone()));
    assert_eq!(args["subject"], json!(format!("eip155:1:0x{}", "33".repeat(20))));

    claim.chain = "polygon".into();
    claim.subject = Some("bob.near".into());
    set_result(mpc_response(payload_hash(&claim), 4));
    let args = attest_call(c.on_foreign_verified(claim));
    assert_eq!(args["subject"], json!("bob.near"));
}

#[test]
fn foreign_failed_promise_does_not_panic() {
    let mut c = setup();
    let claim = claim();
    let hash = payload_hash(&claim);
    set_result(PromiseResult::Failed);
    let o = value(c.on_foreign_verified(claim));
    assert_eq!(o, Outcome::new(Uid(hash.0), "failed"));
    let e = events("foreign_tx_failed");
    assert_eq!(e[0]["reason"], json!("the MPC call failed or timed out"));
    assert_eq!(e[0]["payload_hash"], json!(hash.to_hex()));
    assert!(!c.is_event_attested(Uid(hash.0)));
    assert!(calls().is_empty());
}

#[test]
fn foreign_payload_hash_mismatch_fails() {
    let mut c = setup();
    let claim = claim();
    set_result(mpc_response(HexArray([0x99; 32]), 4));
    let o = value(c.on_foreign_verified(claim));
    assert_eq!(o.status, "failed");
    assert_eq!(events("foreign_tx_failed")[0]["reason"], json!("the MPC signed another payload hash"));
}

#[test]
fn foreign_wrong_mpc_key_fails() {
    let mut c = setup();
    let claim = claim();
    let hash = payload_hash(&claim);
    set_result(mpc_response(hash, 5));
    let o = value(c.on_foreign_verified(claim));
    assert_eq!(o.status, "failed");
    assert_eq!(events("foreign_tx_failed")[0]["reason"], json!("invalid MPC signature"));
    assert!(!c.is_event_attested(Uid(hash.0)));
}

#[test]
fn foreign_tampered_signature_fails() {
    let mut c = setup();
    let claim = claim();
    let hash = payload_hash(&claim);
    let mut sig = mpc_sign(&secp(4), &hash.0);
    sig.recovery_id ^= 1;
    let response = mpc::VerifyForeignTransactionResponse {
        payload_hash: hash,
        signature: SignatureResponse::Secp256k1(sig),
    };
    set_result(PromiseResult::Successful(serde_json::to_vec(&response).unwrap()));
    assert_eq!(value(c.on_foreign_verified(claim)).status, "failed");
}

#[test]
fn foreign_ed25519_or_garbage_response_fails() {
    let mut c = setup();
    let claim = claim();
    let hash = payload_hash(&claim);
    let response = mpc::VerifyForeignTransactionResponse {
        payload_hash: hash,
        signature: SignatureResponse::Ed25519 { signature: vec![0; 64] },
    };
    set_result(PromiseResult::Successful(serde_json::to_vec(&response).unwrap()));
    assert_eq!(value(c.on_foreign_verified(claim.clone())).status, "failed");
    set_result(PromiseResult::Successful(b"{\"nope\":1}".to_vec()));
    assert_eq!(value(c.on_foreign_verified(claim)).status, "failed");
    assert_eq!(
        events("foreign_tx_failed")[0]["reason"],
        json!("the MPC response is not a VerifyForeignTransactionResponse")
    );
}

#[test]
fn foreign_attest_outcome_passes_through_or_releases() {
    let mut c = setup();
    let claim = claim();
    let hash = Uid(payload_hash(&claim).0);
    set_result(mpc_response(payload_hash(&claim), 4));
    drop(c.on_foreign_verified(claim.clone()));
    assert!(c.is_event_attested(hash));

    let created = Outcome::new(Uid([0x77; 32]), "created");
    set_result(PromiseResult::Successful(serde_json::to_vec(&created).unwrap()));
    assert_eq!(c.on_foreign_attested(claim.clone(), hash), created);
    assert!(c.is_event_attested(hash));

    let rejected = Outcome::new(Uid([0x77; 32]), "rejected");
    set_result(PromiseResult::Successful(serde_json::to_vec(&rejected).unwrap()));
    assert_eq!(c.on_foreign_attested(claim.clone(), hash), rejected);
    assert!(!c.is_event_attested(hash));

    set_result(mpc_response(payload_hash(&claim), 4));
    drop(c.on_foreign_verified(claim.clone()));
    set_result(PromiseResult::Failed);
    assert_eq!(c.on_foreign_attested(claim, hash), Outcome::new(hash, "failed"));
    assert!(!c.is_event_attested(hash));
    assert_eq!(events("foreign_tx_failed")[0]["reason"], json!("the attestation call failed"));
}

// ---------------------------------------------------------------- wallet links

#[test]
fn link_messages() {
    let c = setup();
    let addr = eth_addr(&secp(6));
    let m = c.link_message(acc("alice.testnet"), "eip155".into(), addr.to_uppercase().replace("0X", "0x"));
    assert_eq!(
        m,
        format!("Attestra wallet link\nNEAR account: alice.testnet\nWallet: eip155:1:{addr}\nVerifier: {SELF}\nNonce: 0")
    );
    let sol = near_sdk::bs58::encode(nearai_ed().verifying_key().to_bytes()).into_string();
    let m = c.link_message(acc("alice.testnet"), "solana".into(), sol.clone());
    assert_eq!(
        m,
        format!(
            "Attestra wallet link\nNEAR account: alice.testnet\nWallet: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:{sol}\nVerifier: {SELF}\nNonce: 0"
        )
    );
}

#[test]
#[should_panic(expected = "chain must be eip155 or solana")]
fn link_unknown_chain() {
    setup().link_message(acc("alice.testnet"), "cosmos".into(), "x".into());
}

#[test]
#[should_panic(expected = "an eip155 address is 0x followed by 40 hex characters")]
fn link_bad_eth_address() {
    setup().link_message(acc("alice.testnet"), "eip155".into(), "ab".repeat(20));
}

#[test]
#[should_panic(expected = "a solana address is the base58 of 32 bytes")]
fn link_bad_solana_address() {
    setup().link_message(acc("alice.testnet"), "solana".into(), "abc".into());
}

fn link_eth(c: &mut Contract, who: &str, seed: u8) -> Value {
    set(who, 0);
    let addr = eth_addr(&secp(seed));
    let message = c.link_message(acc(who), "eip155".into(), addr.clone());
    let sig = format!("0x{}", hex::encode(personal_sign(&secp(seed), &message)));
    let p = c.link_wallet("eip155".into(), addr, sig);
    attest_call(PromiseOrValue::Promise(p))
}

#[test]
fn link_eth_wallet() {
    let mut c = setup();
    let args = link_eth(&mut c, "alice.testnet", 6);
    let addr = eth_addr(&secp(6));
    let caip10 = format!("eip155:1:{addr}");
    assert_eq!(args["schema_uid"], json!(schema(3).to_hex()));
    assert_eq!(args["subject"], json!("alice.testnet"));
    assert_eq!(data_of(&args), borsh::to_vec(&("eip155", &addr, &caip10)).unwrap());
    assert_eq!(c.linked_account(caip10.clone()), Some(acc("alice.testnet")));
    assert_eq!(c.link_nonce(acc("alice.testnet")), 1);
    let e = events("wallet_linked");
    assert_eq!(e[0]["caip10"], json!(caip10));
    assert_eq!(e[0]["nonce"], json!(0));
    assert_eq!(e[0]["previous"], Value::Null);

    // The same wallet linked to another account replaces the link.
    link_eth(&mut c, "bob.testnet", 6);
    assert_eq!(c.linked_account(caip10), Some(acc("bob.testnet")));
    assert_eq!(events("wallet_linked")[0]["previous"], json!("alice.testnet"));
}

#[test]
fn link_eth_with_v_zero() {
    let mut c = setup();
    set("alice.testnet", 0);
    let addr = eth_addr(&secp(6));
    let message = c.link_message(acc("alice.testnet"), "eip155".into(), addr.clone());
    let mut sig = personal_sign(&secp(6), &message);
    sig[64] -= 27;
    drop(c.link_wallet("eip155".into(), addr, hex::encode(sig)));
    assert_eq!(c.link_nonce(acc("alice.testnet")), 1);
}

#[test]
#[should_panic(expected = "invalid wallet signature")]
fn link_eth_wrong_signer() {
    let mut c = setup();
    set("alice.testnet", 0);
    let addr = eth_addr(&secp(6));
    let message = c.link_message(acc("alice.testnet"), "eip155".into(), addr.clone());
    let _ = c.link_wallet("eip155".into(), addr, hex::encode(personal_sign(&secp(7), &message)));
}

#[test]
#[should_panic(expected = "invalid wallet signature")]
fn link_eth_signature_for_another_account() {
    let mut c = setup();
    let addr = eth_addr(&secp(6));
    let message = c.link_message(acc("bob.testnet"), "eip155".into(), addr.clone());
    set("alice.testnet", 0);
    let _ = c.link_wallet("eip155".into(), addr, hex::encode(personal_sign(&secp(6), &message)));
}

#[test]
#[should_panic(expected = "invalid wallet signature")]
fn link_signature_cannot_be_replayed() {
    let mut c = setup();
    set("alice.testnet", 0);
    let addr = eth_addr(&secp(6));
    let message = c.link_message(acc("alice.testnet"), "eip155".into(), addr.clone());
    let sig = hex::encode(personal_sign(&secp(6), &message));
    drop(c.link_wallet("eip155".into(), addr.clone(), sig.clone()));
    let _ = c.link_wallet("eip155".into(), addr, sig);
}

#[test]
#[should_panic(expected = "an eip155 signature is 65 bytes of hex")]
fn link_eth_short_signature() {
    let mut c = setup();
    let _ = c.link_wallet("eip155".into(), eth_addr(&secp(6)), "00".repeat(64));
}

#[test]
fn link_solana_wallet_hex_and_base58() {
    let mut c = setup();
    let key = SigningKey::from_bytes(&[9; 32]);
    let address = near_sdk::bs58::encode(key.verifying_key().to_bytes()).into_string();
    let caip10 = format!("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:{address}");

    set("alice.testnet", 0);
    let message = c.link_message(acc("alice.testnet"), "solana".into(), address.clone());
    let sig = hex::encode(key.sign(message.as_bytes()).to_bytes());
    let args = attest_call(PromiseOrValue::Promise(c.link_wallet("solana".into(), address.clone(), sig)));
    assert_eq!(data_of(&args), borsh::to_vec(&("solana", &address, &caip10)).unwrap());
    assert_eq!(c.linked_account(caip10.clone()), Some(acc("alice.testnet")));

    set("alice.testnet", 0);
    let message = c.link_message(acc("alice.testnet"), "solana".into(), address.clone());
    assert!(message.ends_with("Nonce: 1"));
    let sig = near_sdk::bs58::encode(key.sign(message.as_bytes()).to_bytes()).into_string();
    drop(c.link_wallet("solana".into(), address, sig));
    assert_eq!(c.link_nonce(acc("alice.testnet")), 2);
}

#[test]
#[should_panic(expected = "invalid wallet signature")]
fn link_solana_wrong_signer() {
    let mut c = setup();
    set("alice.testnet", 0);
    let key = SigningKey::from_bytes(&[9; 32]);
    let address = near_sdk::bs58::encode(key.verifying_key().to_bytes()).into_string();
    let message = c.link_message(acc("alice.testnet"), "solana".into(), address.clone());
    let other = SigningKey::from_bytes(&[10; 32]);
    let _ = c.link_wallet("solana".into(), address, hex::encode(other.sign(message.as_bytes()).to_bytes()));
}

#[test]
#[should_panic(expected = "a solana signature is 64 bytes, hex or base58")]
fn link_solana_bad_signature_encoding() {
    let mut c = setup();
    let key = SigningKey::from_bytes(&[9; 32]);
    let address = near_sdk::bs58::encode(key.verifying_key().to_bytes()).into_string();
    let _ = c.link_wallet("solana".into(), address, "0OIl".into());
}

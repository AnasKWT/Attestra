//! Compatibility with the TypeScript code, from vectors it computed (tests/fixtures/ts.json,
//! written by scripts/fixtures.ts).

use attestra_checker::check::{rule_prompt, Rule};
use attestra_checker::e2ee::{decrypt_with_ed25519_seed, encrypt_with};
use attestra_checker::encode_uri_component;
use attestra_checker::nearai::{verify_ed25519, Signature};
use attestra_checker::verdict::{verdict_digest, AiVerdict};
use ed25519_dalek::SigningKey;
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/ts.json")).unwrap()
}

fn arr<const N: usize>(v: &Value) -> [u8; N] {
    hex::decode(v.as_str().unwrap()).unwrap().try_into().unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

#[test]
fn derives_the_same_ed25519_public_keys() {
    let f = fixture();
    for (seed, public) in [("model_seed", "model_pub"), ("client_seed", "client_pub")] {
        let key = SigningKey::from_bytes(&arr(&f[seed]));
        assert_eq!(hex::encode(key.verifying_key().as_bytes()), s(&f[public]));
    }
}

#[test]
fn decrypts_what_the_sdk_encrypts_to_the_model() {
    let f = fixture();
    let seed = arr(&f["model_seed"]);
    for case in f["to_model"].as_array().unwrap() {
        assert_eq!(decrypt_with_ed25519_seed(s(&case["ciphertext"]), &seed).unwrap(), s(&case["plaintext"]));
    }
}

#[test]
fn encrypts_byte_for_byte_like_the_sdk() {
    let f = fixture();
    let d = &f["deterministic"];
    let ct =
        encrypt_with(s(&d["plaintext"]), s(&f["model_pub"]), arr(&d["ephemeral"]), arr(&d["nonce"])).unwrap();
    assert_eq!(ct, s(&d["ciphertext"]));
    assert_eq!(decrypt_with_ed25519_seed(&ct, &arr(&f["model_seed"])).unwrap(), s(&d["plaintext"]));
}

#[test]
fn decrypts_a_response_encrypted_to_the_client_key() {
    let f = fixture();
    let r = &f["response"];
    assert_eq!(
        decrypt_with_ed25519_seed(s(&r["ciphertext"]), &arr(&f["client_seed"])).unwrap(),
        s(&r["plaintext"])
    );
    // The wrong key, or a flipped byte, does not open it.
    assert!(decrypt_with_ed25519_seed(s(&r["ciphertext"]), &arr(&f["model_seed"])).is_err());
    let mut tampered = hex::decode(s(&r["ciphertext"])).unwrap();
    *tampered.last_mut().unwrap() ^= 1;
    assert_eq!(
        decrypt_with_ed25519_seed(&hex::encode(tampered), &arr(&f["client_seed"])).unwrap_err(),
        "decryption failed"
    );
}

#[test]
fn verifies_a_near_ai_style_signature_and_rejects_tampering() {
    let f = fixture();
    let sig = &f["signature"];
    let mut good = Signature {
        text: s(&sig["text"]).into(),
        signature: s(&sig["signature"]).into(),
        signing_address: None,
        signing_algo: "ed25519".into(),
    };
    assert!(verify_ed25519(&good, s(&sig["key"])));
    good.signature = format!("0x{}", good.signature);
    assert!(verify_ed25519(&good, s(&sig["key"])), "a 0x prefix is accepted");

    let mut other_text = good.clone();
    other_text.text.push('0');
    assert!(!verify_ed25519(&other_text, s(&sig["key"])));
    let mut other_algo = good.clone();
    other_algo.signing_algo = "ecdsa".into();
    assert!(!verify_ed25519(&other_algo, s(&sig["key"])));
    assert!(!verify_ed25519(&good, s(&f["client_pub"])));
    assert!(!verify_ed25519(&good, "zz"));
}

#[test]
fn computes_the_sdk_verdict_digest() {
    let f = fixture();
    let v: AiVerdict = serde_json::from_value(f["verdict"]["verdict"].clone()).unwrap();
    assert_eq!(hex::encode(verdict_digest(&v).unwrap()), s(&f["verdict"]["digest"]));
}

#[test]
fn builds_the_agent_rule_prompt() {
    let f = fixture();
    let rule: Rule = serde_json::from_value(f["rule_prompt"]["rule"].clone()).unwrap();
    assert_eq!(rule_prompt(&rule), s(&f["rule_prompt"]["prompt"]));
}

#[test]
fn encodes_uri_components_like_javascript() {
    for case in fixture()["uri"].as_array().unwrap() {
        assert_eq!(encode_uri_component(s(&case["input"])), s(&case["encoded"]));
    }
}

//! The whole check against a mocked NEAR AI Cloud, NEAR RPC and GitHub.

mod common;

use attestra_checker::check::{rule_prompt, run_check, CheckInput, CheckOutput, Rule};
use attestra_checker::nearai::{sha256_hex, signed_hashes, verify_ed25519, Signature};
use attestra_checker::verdict::verdict_digest;
use attestra_checker::{handle, near_public_key, Method};
use base64::Engine;
use common::*;
use ed25519_dalek::{Signature as EdSignature, Verifier, VerifyingKey};

fn input(rule_id: &str, evidence: String) -> CheckInput {
    let mut i = CheckInput {
        request_id: "AB".repeat(32),
        rule_id: rule_id.into(),
        subject: "bob.testnet".into(),
        model: MODEL.into(),
        encrypted_evidence: evidence,
        github: None,
        subject_proof: None,
    };
    prove(&mut i);
    i
}

/// What the verdicts contract checks, done here with an independent ed25519 implementation path.
fn assert_contract_would_accept(out: &CheckOutput) {
    let key = bs58::decode(out.enclave_key.strip_prefix("ed25519:").unwrap()).into_vec().unwrap();
    let key = VerifyingKey::from_bytes(&key.try_into().unwrap()).unwrap();
    let sig = base64::engine::general_purpose::STANDARD.decode(&out.enclave_signature).unwrap();
    let sig = EdSignature::from_bytes(&sig.try_into().unwrap());
    key.verify(&verdict_digest(&out.verdict).unwrap(), &sig).unwrap();
    let nearai = Signature {
        text: out.nearai.text.clone(),
        signature: out.nearai.signature.clone(),
        signing_address: None,
        signing_algo: out.nearai.algo.clone(),
    };
    assert!(verify_ed25519(&nearai, &out.nearai.key));
    let hashes = signed_hashes(&out.nearai.text);
    assert_eq!(hashes.request_hash, out.verdict.evidence_hash);
    assert_eq!(hashes.model.as_deref(), Some(out.verdict.model.as_str()));
    assert!(!out.nearai.signature.starts_with("0x"));
}

#[test]
fn encrypts_end_to_end_checks_the_model_signature_and_signs_a_verdict_the_contract_accepts() {
    let mock = Mock::new("PASS");
    let out = run_check(&mock, &input("age_over_18", evidence("Date of birth: 1990-04-02"))).unwrap();

    let rule = Rule { id: "age_over_18".into(), claim: "is at least 18 years old".into(), enabled: true };
    assert_eq!(*mock.seen.borrow(), vec![rule_prompt(&rule), "Date of birth: 1990-04-02".to_string()]);
    assert_eq!(out.answer, "PASS");
    assert!(out.verdict.result);
    assert_eq!(out.verdict.request_id, "ab".repeat(32));
    assert_eq!(out.verdict.rule_id, "age_over_18");
    assert_eq!(out.verdict.subject, "bob.testnet");
    assert_eq!(out.verdict.model, MODEL);
    assert_eq!(out.verdict.issued_at, NOW);
    assert_eq!(out.verdict.expires_at, NOW + 365 * 86_400);
    assert_eq!(out.enclave_key, near_public_key(&checker_key().verifying_key().to_bytes()));
    assert_eq!(out.nearai.key, model_pub());
    assert_eq!(out.nearai.algo, "ed25519");
    assert_contract_would_accept(&out);

    // The request: the E2EE headers, the body hashed into the verdict, the agent's field order.
    let chat = &mock.requests_to("/chat/completions")[0];
    assert_eq!(chat.method, Method::Post);
    let header = |n: &str| chat.headers.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()).unwrap();
    assert_eq!(header("X-Signing-Algo"), "ed25519");
    assert_eq!(header("X-Encryption-Version"), "2");
    assert_eq!(header("X-Model-Pub-Key"), model_pub());
    assert_eq!(header("X-Client-Pub-Key").len(), 64);
    let body = String::from_utf8(chat.body.clone().unwrap()).unwrap();
    assert_eq!(sha256_hex(body.as_bytes()), out.verdict.evidence_hash);
    assert!(
        body.starts_with(r#"{"model":"z-ai/glm-5.3-flash","messages":[{"role":"system","content":""#),
        "{body}"
    );
    assert!(body.ends_with(r#""}],"temperature":0,"max_tokens":1024,"stream":false}"#), "{body}");

    let report = &mock.requests_to("/attestation/report")[0];
    assert!(report.url.starts_with("https://cloud-api.near.ai/v1/attestation/report?model=z-ai%2Fglm-5.3-flash&signing_algo=ed25519&nonce="));
    let sig = &mock.requests_to("/signature/")[0];
    assert_eq!(
        sig.url,
        "https://cloud-api.near.ai/v1/signature/chat-1?model=z-ai%2Fglm-5.3-flash&signing_algo=ed25519"
    );
}

#[test]
fn the_json_output_has_the_agent_check_output_shape() {
    let mock = Mock::new("PASS");
    let mut req = input("age_over_18", evidence("passport: 1980"));
    req.request_id = "cd".repeat(32);
    prove(&mut req);
    let raw = serde_json::json!({
        "operation": "check",
        "request_id": req.request_id,
        "rule_id": req.rule_id,
        "subject": req.subject,
        "model": MODEL,
        "encrypted_evidence": req.encrypted_evidence,
        "github": null,
        "subject_proof": req.subject_proof,
    });
    let out = handle(&mock, &raw.to_string());
    let mut keys: Vec<&str> = out.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, ["answer", "enclaveKey", "enclaveSignature", "nearai", "verdict"]);
    let mut verdict_keys: Vec<&str> =
        out["verdict"].as_object().unwrap().keys().map(String::as_str).collect();
    verdict_keys.sort();
    assert_eq!(
        verdict_keys,
        ["evidence_hash", "expires_at", "issued_at", "model", "request_id", "result", "rule_id", "subject"]
    );
    let mut nearai_keys: Vec<&str> = out["nearai"].as_object().unwrap().keys().map(String::as_str).collect();
    nearai_keys.sort();
    assert_eq!(nearai_keys, ["algo", "key", "signature", "text"]);
    assert!(out["verdict"]["issued_at"].is_u64());
    let parsed: CheckOutput = serde_json::from_value(out).unwrap();
    assert_contract_would_accept(&parsed);
}

#[test]
fn a_fail_answer_becomes_result_false() {
    let out = run_check(&Mock::new("FAIL"), &input("age_over_18", evidence("nothing"))).unwrap();
    assert!(!out.verdict.result);
    assert_eq!(out.answer, "FAIL");
    assert_contract_would_accept(&out);
}

#[test]
fn an_empty_answer_is_an_error_not_a_fail() {
    // What a reasoning model returns when the token limit cuts it off before it answers.
    let err = run_check(&Mock::new(""), &input("age_over_18", evidence("born 1990"))).unwrap_err();
    assert!(err.contains("no verdict"), "{err}");
}

#[test]
fn a_plaintext_answer_is_read_as_is() {
    let mut mock = Mock::new(" pass\n");
    mock.plaintext_answer = true;
    let out = run_check(&mock, &input("age_over_18", evidence("x"))).unwrap();
    assert_eq!(out.answer, "PASS");
    assert!(out.verdict.result);
}

#[test]
fn refuses_plaintext_evidence() {
    let err =
        run_check(&Mock::new("PASS"), &input("age_over_18", "my passport says 1990".into())).unwrap_err();
    assert!(err.contains("encrypted"), "{err}");
    let err = run_check(&Mock::new("PASS"), &input("age_over_18", String::new())).unwrap_err();
    assert!(err.contains("encrypted"), "{err}");
}

#[test]
fn reads_the_rule_from_the_contract_and_refuses_unknown_or_disabled_rules() {
    for id in ["retired", "made_up"] {
        let mock = Mock::new("PASS");
        let err = run_check(&mock, &input(id, evidence("x"))).unwrap_err();
        assert_eq!(err, format!("unknown or disabled rule {id}"));
        assert!(mock.requests_to("cloud-api.near.ai").is_empty(), "no NEAR AI call for a refused rule");
    }
}

#[test]
fn falls_back_to_the_next_rpc() {
    let mut mock = Mock::new("PASS");
    mock.failing_rpc = vec!["https://test.rpc.fastnear.com"];
    run_check(&mock, &input("age_over_18", evidence("x"))).unwrap();
    // The key lookup and the rules each fail over once.
    assert_eq!(mock.requests_to("fastnear.com").len(), 4);
}

#[test]
fn fetches_github_facts_itself() {
    let mock = Mock::new("PASS");
    let mut req = input("github_contributor", String::new());
    req.github = Some("octo-cat".into());
    prove(&mut req);
    let out = run_check(&mock, &req).unwrap();
    assert!(out.verdict.result);
    assert_eq!(
        mock.seen.borrow()[1],
        "Fetched by the checker from api.github.com just now: the GitHub user \"octo-cat\" has 12 merged pull requests in public repositories."
    );
    let gh = &mock.requests_to("api.github.com/search")[0];
    assert_eq!(
        gh.url,
        "https://api.github.com/search/issues?q=type%3Apr%20author%3Aocto-cat%20is%3Amerged&per_page=1"
    );
    assert!(gh.headers.iter().any(|(k, v)| k == "user-agent" && v == "attestra-checker"));
    assert!(!gh.headers.iter().any(|(k, _)| k == "authorization"));

    let mut no_login = input("github_contributor", String::new());
    no_login.github = None;
    assert_eq!(run_check(&Mock::new("PASS"), &no_login).unwrap_err(), "this rule needs a GitHub login");
    no_login.github = Some("bad login!".into());
    prove(&mut no_login);
    assert_eq!(run_check(&Mock::new("PASS"), &no_login).unwrap_err(), "not a GitHub login");
}

#[test]
fn rejects_a_signature_over_another_request_or_response_or_by_another_key() {
    let mut mock = Mock::new("PASS");
    mock.sign_request_hash = Some("00".repeat(32));
    assert_eq!(
        run_check(&mock, &input("age_over_18", evidence("x"))).unwrap_err(),
        "the model signed a different request"
    );

    let mut mock = Mock::new("PASS");
    mock.sign_response_hash = Some("00".repeat(32));
    assert_eq!(
        run_check(&mock, &input("age_over_18", evidence("x"))).unwrap_err(),
        "the model signed a different response"
    );

    let mut mock = Mock::new("PASS");
    mock.signer_seed = Some([8; 32]);
    assert_eq!(
        run_check(&mock, &input("age_over_18", evidence("x"))).unwrap_err(),
        "the model signature does not verify against the attested key"
    );
}

#[test]
fn retries_the_signature_lookup() {
    let mut mock = Mock::new("PASS");
    mock.signature_misses = 2;
    run_check(&mock, &input("age_over_18", evidence("x"))).unwrap();
    assert_eq!(mock.requests_to("/signature/").len(), 3);
    assert_eq!(*mock.sleeps.borrow(), vec![700, 1400]);

    let mut mock = Mock::new("PASS");
    mock.signature_misses = 6;
    let err = run_check(&mock, &input("age_over_18", evidence("x"))).unwrap_err();
    assert!(err.starts_with("no signature for chat chat-1: 404"), "{err}");
    assert_eq!(mock.sleeps.borrow().len(), 5);
}

#[test]
fn validates_input_and_environment() {
    let mut bad = input("age_over_18", evidence("x"));
    bad.request_id = "12".into();
    assert_eq!(run_check(&Mock::new("PASS"), &bad).unwrap_err(), "request_id must be 64 hex characters");

    let mut bad = input("age_over_18", evidence("x"));
    bad.model = String::new();
    assert_eq!(run_check(&Mock::new("PASS"), &bad).unwrap_err(), "invalid model name");

    let mut mock = Mock::new("PASS");
    mock.env.retain(|(k, _)| *k != "NEAR_NETWORK_ID");
    assert!(run_check(&mock, &input("age_over_18", evidence("x")))
        .unwrap_err()
        .starts_with("NEAR_NETWORK_ID must be"));

    let mut mock = Mock::new("PASS");
    mock.env.retain(|(k, _)| *k != "NEARAI_API_KEY");
    assert_eq!(
        run_check(&mock, &input("age_over_18", evidence("x"))).unwrap_err(),
        "NEARAI_API_KEY is not set"
    );
}

#[test]
fn answers_its_public_key_and_reports_errors_as_json() {
    let mock = Mock::new("PASS");
    let out = handle(&mock, r#"{"operation":"public_key"}"#);
    assert_eq!(
        out,
        serde_json::json!({ "enclaveKey": near_public_key(&checker_key().verifying_key().to_bytes()) })
    );
    assert!(mock.requests.borrow().is_empty());

    let out = handle(&mock, r#"{"operation":"sign","message_hex":"00"}"#);
    assert!(out["error"].as_str().unwrap().starts_with("invalid input"), "{out}");
    let out = handle(&mock, "not json");
    assert!(out["error"].is_string());
}

#[test]
fn the_subject_must_sign_the_request_with_its_own_key() {
    // No proof.
    let mut req = input("age_over_18", evidence("born 1990"));
    req.subject_proof = None;
    assert_eq!(run_check(&Mock::new("PASS"), &req).unwrap_err(), "the subject must sign the request (subject_proof)");

    // Someone else's key, valid signature: not a key of bob.testnet.
    let mut stranger = input("age_over_18", evidence("born 1990"));
    let other = ed25519_dalek::SigningKey::from_bytes(&[6; 32]);
    prove_with(&mut stranger, &other, NOW + 600);
    let err = run_check(&Mock::new("PASS"), &stranger).unwrap_err();
    assert!(err.contains("is not a full-access key of bob.testnet"), "{err}");

    // A function-call key is not enough either.
    let mut fc = Mock::new("PASS");
    fc.full_access.clear();
    assert!(run_check(&fc, &input("age_over_18", evidence("born 1990"))).unwrap_err().contains("is not a full-access key"));

    // The proof is for other evidence, another rule or another subject.
    let mut swapped = input("age_over_18", evidence("born 1990"));
    swapped.encrypted_evidence = evidence("born 2015");
    assert_eq!(run_check(&Mock::new("PASS"), &swapped).unwrap_err(), "the signed message names other evidence");
    let mut other_subject = input("age_over_18", evidence("born 1990"));
    other_subject.subject = "carol.testnet".into();
    assert_eq!(run_check(&Mock::new("PASS"), &other_subject).unwrap_err(), "the signed message names another rule or subject");

    // Expired, or valid for too long.
    let mut old = input("age_over_18", evidence("born 1990"));
    prove_with(&mut old, &subject_key(), NOW - 1);
    assert_eq!(run_check(&Mock::new("PASS"), &old).unwrap_err(), "the signed request has expired");
    let mut long = input("age_over_18", evidence("born 1990"));
    prove_with(&mut long, &subject_key(), NOW + 2 * 86_400);
    assert_eq!(run_check(&Mock::new("PASS"), &long).unwrap_err(), "the signed request is valid for more than a day");

    // A tampered signature.
    let mut tampered = input("age_over_18", evidence("born 1990"));
    let p = tampered.subject_proof.as_mut().unwrap();
    p.message = p.message.replace("\"deadline\"", "\"deadline\" ");
    assert_eq!(run_check(&Mock::new("PASS"), &tampered).unwrap_err(), "the subject's signature does not verify");

    // CAIP-10 subjects cannot sign a NEAR request.
    let mut caip = input("age_over_18", evidence("born 1990"));
    caip.subject = "eip155:1:0xabcdef0123456789abcdef0123456789abcdef01".into();
    assert_eq!(run_check(&Mock::new("PASS"), &caip).unwrap_err(), "a private check is about a NEAR account");
}

#[test]
fn an_implicit_account_proves_with_the_key_it_is_made_of() {
    let key = ed25519_dalek::SigningKey::from_bytes(&[8; 32]);
    let mut req = input("age_over_18", evidence("born 1990"));
    req.subject = hex::encode(key.verifying_key().to_bytes());
    prove_with(&mut req, &key, NOW + 600);
    let mock = Mock::new("PASS");
    assert!(run_check(&mock, &req).unwrap().verdict.result);
    // No RPC lookup is needed for an implicit account.
    assert!(mock.requests_to("fastnear.com").iter().all(|r| !String::from_utf8_lossy(r.body.as_ref().unwrap()).contains("view_access_key")));
}

#[test]
fn a_github_rule_needs_the_logins_gist_naming_the_subject() {
    let mut req = input("github_contributor", String::new());
    req.github = Some("octo-cat".into());
    prove(&mut req);
    let mut none = Mock::new("PASS");
    none.gist = None;
    assert_eq!(run_check(&none, &req).unwrap_err(), "octo-cat has no public gist attestra.txt with the line attestra:bob.testnet");
    let mut other = Mock::new("PASS");
    other.gist = Some("attestra:mallory.testnet".into());
    assert!(run_check(&other, &req).is_err());
    // The facts are only counted once the owner agreed.
    assert!(other.requests_to("api.github.com/search").is_empty());
    let ok = Mock::new("PASS");
    assert!(run_check(&ok, &req).unwrap().verdict.result);
}

#[test]
fn the_nep413_hash_matches_the_sdk() {
    // The same vector packages/sdk/test/subject-proof.test.ts checks.
    let h = attestra_checker::proof::nep413_hash(r#"{"action":"private_check"}"#, &[0x5a; 32], "verdicts.attestra.testnet");
    assert_eq!(hex::encode(h), "bc4a661274abe9eb4c9df6fc9bf5911fb5e638d602c137285393247c0058900c");
}

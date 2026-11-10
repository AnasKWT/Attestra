//! The verdicts contract: AI checks signed by an enclave and NEAR AI, wallet links, and foreign
//! events verified by an MPC double.

use attestra_sandbox_tests::crypto::{
    attestation_uid, b64, ed_key, eth_address, foreign_attestation_data, foreign_payload_hash,
    instruction_payload_hash, mpc_signature, near_public_key, nearai_proof_ecdsa, nearai_proof_ed25519,
    personal_sign, secp_key, sha256, EvmLog, Verdict,
};
use attestra_sandbox_tests::setup::{CLAIM, MODEL, RULE};
use attestra_sandbox_tests::util::{chain_secs, event, events, fails_with, ok, u128_of, yocto, TX_GAS};
use attestra_sandbox_tests::Env;
use borsh::BorshSerialize;
use ed25519_dalek::Signer;
use near_workspaces::result::ExecutionFinalResult;
use serde_json::{json, Value};

async fn submit(
    env: &Env,
    verdict: &Verdict,
    enclave_signature: String,
    proof: Value,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(env
        .relayer
        .call(env.verdicts.id(), "submit_ai_verdict")
        .args_json(json!({
            "verdict": verdict.json(),
            "enclave_key": near_public_key(&env.keys.enclave),
            "enclave_signature": enclave_signature,
            "nearai": proof,
        }))
        .gas(TX_GAS)
        .transact()
        .await?)
}

/// Submits a verdict signed by the configured enclave with an ed25519 NEAR AI proof.
async fn submit_ed(env: &Env, verdict: &Verdict) -> anyhow::Result<ExecutionFinalResult> {
    let proof = nearai_proof_ed25519(&env.keys.nearai_ed, &verdict.nearai_text());
    submit(env, verdict, verdict.enclave_signature(&env.keys.enclave), proof).await
}

fn verdict(seed: u8, result: bool, issued_at: u64) -> Verdict {
    Verdict {
        request_id: [seed; 32],
        rule_id: RULE.to_string(),
        subject: "bob.test.near".to_string(),
        result,
        evidence_hash: sha256(format!("request body {seed}").as_bytes()),
        model: MODEL.to_string(),
        issued_at,
        expires_at: 0,
    }
}

#[tokio::test]
async fn ai_verdicts() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let verdicts = env.verdicts.id().as_str();
    let ai_check = env.verdict_schemas.ai_check.clone();
    let now = chain_secs(&env.worker).await?;

    // A pass with an ed25519 NEAR AI signature becomes an ai_check attestation.
    let v = verdict(0x21, true, now);
    let result = ok(submit_ed(&env, &v).await?);
    let outcome: Value = result.clone().json()?;
    let data = v.attestation_data(CLAIM);
    let uid = attestation_uid(&ai_check, &v.subject, verdicts, &data, 0);
    assert_eq!(outcome, json!({ "uid": uid, "status": "created" }));
    let accepted = event(&result, "verdict_accepted");
    assert_eq!(accepted["request_id"], hex::encode(v.request_id));
    assert_eq!(accepted["result"], true);
    assert_eq!(accepted["nearai_key"], hex::encode(env.keys.nearai_ed.verifying_key().to_bytes()));
    assert_eq!(event(&result, "attestation_created")["attester"], verdicts);
    let a = env.attestation(&uid).await?.expect("stored");
    assert_eq!(a["schema_uid"], ai_check);
    assert_eq!(a["attester"], verdicts);
    assert_eq!(a["subject"], v.subject);
    assert_eq!(a["data"], b64(&data));
    assert_eq!(a["status"], "active");
    let used: bool = env
        .view(&env.verdicts, "is_request_used", json!({ "request_id": hex::encode(v.request_id) }))
        .await?;
    assert!(used);
    fails_with(submit_ed(&env, &v).await?, "this request id was already used");

    // A pass with an ecdsa (EIP-191) NEAR AI signature and an expiry.
    let mut v2 = verdict(0x22, true, now);
    v2.expires_at = now + 3_600;
    let proof = nearai_proof_ecdsa(&env.keys.nearai_ecdsa, &v2.nearai_text());
    let result = ok(submit(&env, &v2, v2.enclave_signature(&env.keys.enclave), proof).await?);
    let outcome: Value = result.json()?;
    let uid2 = attestation_uid(&ai_check, &v2.subject, verdicts, &v2.attestation_data(CLAIM), 1);
    assert_eq!(outcome, json!({ "uid": uid2, "status": "created" }));
    assert_eq!(env.attestation(&uid2).await?.expect("stored")["expiration_time"], v2.expires_at);

    // Bad signatures.
    let v3 = verdict(0x23, true, now);
    let mut other = v3.clone();
    other.subject = "carol.test.near".to_string();
    let proof = nearai_proof_ed25519(&env.keys.nearai_ed, &v3.nearai_text());
    fails_with(
        submit(&env, &v3, other.enclave_signature(&env.keys.enclave), proof.clone()).await?,
        "invalid enclave signature",
    );
    let unknown = env
        .relayer
        .call(env.verdicts.id(), "submit_ai_verdict")
        .args_json(json!({
            "verdict": v3.json(), "enclave_key": near_public_key(&ed_key(9)),
            "enclave_signature": v3.enclave_signature(&ed_key(9)), "nearai": proof,
        }))
        .gas(TX_GAS)
        .transact()
        .await?;
    fails_with(unknown, "unknown enclave key");
    let enclave_sig = v3.enclave_signature(&env.keys.enclave);
    let mut forged_ed = nearai_proof_ed25519(&env.keys.nearai_ed, &v3.nearai_text());
    forged_ed["signature"] = json!(hex::encode(env.keys.nearai_ed.sign(b"something else").to_bytes()));
    fails_with(submit(&env, &v3, enclave_sig.clone(), forged_ed).await?, "invalid NEAR AI signature");
    let mut forged_ecdsa = nearai_proof_ecdsa(&env.keys.nearai_ecdsa, &v3.nearai_text());
    forged_ecdsa["signature"] = json!(hex::encode(personal_sign(&secp_key(30), &v3.nearai_text())));
    fails_with(submit(&env, &v3, enclave_sig.clone(), forged_ecdsa).await?, "invalid NEAR AI signature");
    let wrong_request = format!("{MODEL}:{}:{}", "ab".repeat(32), "cd".repeat(32));
    let proof = nearai_proof_ed25519(&env.keys.nearai_ed, &wrong_request);
    fails_with(
        submit(&env, &v3, enclave_sig.clone(), proof).await?,
        "the NEAR AI request hash does not match evidence_hash",
    );
    let stranger = nearai_proof_ed25519(&ed_key(31), &v3.nearai_text());
    fails_with(submit(&env, &v3, enclave_sig, stranger).await?, "the NEAR AI key is not a signer of model");
    let mut disabled = verdict(0x24, true, now);
    disabled.rule_id = "off_rule".to_string();
    fails_with(submit_ed(&env, &disabled).await?, "rule off_rule is disabled");
    let stale = verdict(0x25, true, now.saturating_sub(3_600));
    fails_with(submit_ed(&env, &stale).await?, "the verdict is older than 15 minutes");
    // Nothing above consumed v3's request id.
    let _ = ok(submit_ed(&env, &v3).await?);

    // A fail is recorded but not attested.
    let count = env.attestation_count().await?;
    let v4 = verdict(0x26, false, now);
    let result = ok(submit_ed(&env, &v4).await?);
    assert_eq!(
        result.clone().json::<Value>()?,
        json!({ "uid": hex::encode(v4.request_id), "status": "not_attested" })
    );
    assert_eq!(event(&result, "verdict_accepted")["result"], false);
    assert!(events(&result, "attestation_created").is_empty());
    assert_eq!(env.attestation_count().await?, count);
    let used: bool = env
        .view(&env.verdicts, "is_request_used", json!({ "request_id": hex::encode(v4.request_id) }))
        .await?;
    assert!(used);
    Ok(())
}

/// What a wallet link costs bob: the link entries and the attestation.
async fn link_deposit(env: &Env, chain: &str, address: &str) -> anyhow::Result<u128> {
    let args = json!({ "account_id": env.bob.id(), "chain": chain, "address": address });
    Ok(u128_of(&env.view::<Value>(&env.verdicts, "link_wallet_deposit", args).await?))
}

/// What a foreign event costs: its payload entry and the attestation.
async fn event_deposit(env: &Env, claim: Value) -> anyhow::Result<u128> {
    Ok(u128_of(&env.view::<Value>(&env.verdicts, "foreign_event_deposit", json!({ "claim": claim })).await?))
}

/// The verdicts contract's storage balance at the attestations contract, `(total, available)`.
async fn verdicts_storage(env: &Env) -> anyhow::Result<(u128, u128)> {
    Ok(env.storage(&env.attestations, env.verdicts.id()).await?.expect("registered"))
}

#[derive(BorshSerialize)]
struct WalletData<'a>(&'a str, &'a str, &'a str);

#[tokio::test]
async fn wallet_links() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let bob = &env.bob;
    let verdicts = env.verdicts.id().as_str();
    let link = |chain: &str, address: &str, signature: String, deposit: u128| {
        bob.call(env.verdicts.id(), "link_wallet")
            .args_json(json!({ "chain": chain, "address": address, "signature": signature }))
            .deposit(yocto(deposit))
            .gas(TX_GAS)
            .transact()
    };

    // Ethereum: personal_sign over link_message.
    let wallet = secp_key(20);
    let address = eth_address(&wallet);
    let caip10 = format!("eip155:1:{address}");
    let message: String = env
        .view(
            &env.verdicts,
            "link_message",
            json!({ "account_id": bob.id(), "chain": "eip155", "address": address }),
        )
        .await?;
    assert_eq!(
        message,
        format!(
            "Attestra wallet link\nNEAR account: {}\nWallet: {caip10}\nVerifier: {verdicts}\nNonce: 0",
            bob.id()
        )
    );
    let signature = format!("0x{}", hex::encode(personal_sign(&wallet, &message)));
    let deposit = link_deposit(&env, "eip155", &address).await?;
    assert!(deposit > 0);
    // A signature by another wallet is refused.
    let wrong = format!("0x{}", hex::encode(personal_sign(&secp_key(21), &message)));
    fails_with(link("eip155", &address, wrong, deposit).await?, "invalid wallet signature");
    // One yoctoNEAR short is refused, and so is no deposit at all.
    fails_with(link("eip155", &address, signature.clone(), deposit - 1).await?, "attach at least");
    fails_with(link("eip155", &address, signature.clone(), 0).await?, "attach at least");
    // The address may come in any case. The caller pays: the verdicts contract's storage balance
    // at the attestations contract does not shrink.
    let before = verdicts_storage(&env).await?;
    let mixed = format!("0x{}", address[2..].to_uppercase());
    let linked = ok(link("eip155", &mixed, signature.clone(), deposit).await?);
    let after = verdicts_storage(&env).await?;
    assert!(after.1 >= before.1, "the verdicts storage balance went from {before:?} to {after:?}");
    let outcome: Value = linked.clone().json()?;
    assert_eq!(outcome["status"], "created");
    let e = event(&linked, "wallet_linked");
    assert_eq!(e["caip10"], caip10);
    assert_eq!(e["account_id"], bob.id().as_str());
    let a = env.attestation(outcome["uid"].as_str().expect("uid")).await?.expect("stored");
    assert_eq!(a["schema_uid"], env.verdict_schemas.wallet_link);
    assert_eq!(a["attester"], verdicts);
    assert_eq!(a["subject"], bob.id().as_str());
    assert_eq!(a["data"], b64(&borsh::to_vec(&WalletData("eip155", &address, &caip10))?));
    let account: Option<String> =
        env.view(&env.verdicts, "linked_account", json!({ "caip10": caip10 })).await?;
    assert_eq!(account.as_deref(), Some(bob.id().as_str()));
    let nonce: u64 = env.view(&env.verdicts, "link_nonce", json!({ "account_id": bob.id() })).await?;
    assert_eq!(nonce, 1);
    // The nonce moved on, so the same signature cannot link again.
    fails_with(link("eip155", &address, signature, deposit).await?, "invalid wallet signature");

    // Solana: a raw ed25519 signature over the message.
    let sol = ed_key(22);
    let sol_address = bs58::encode(sol.verifying_key().to_bytes()).into_string();
    let message: String = env
        .view(
            &env.verdicts,
            "link_message",
            json!({ "account_id": bob.id(), "chain": "solana", "address": sol_address }),
        )
        .await?;
    assert!(message.ends_with("Nonce: 1"));
    let signature = hex::encode(sol.sign(message.as_bytes()).to_bytes());
    let deposit = link_deposit(&env, "solana", &sol_address).await?;
    let linked = ok(link("solana", &sol_address, signature, deposit).await?);
    assert_eq!(linked.json::<Value>()?["status"], "created");
    let sol_caip10 = format!("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:{sol_address}");
    let account: Option<String> =
        env.view(&env.verdicts, "linked_account", json!({ "caip10": sol_caip10 })).await?;
    assert_eq!(account.as_deref(), Some(bob.id().as_str()));
    Ok(())
}

/// The sample log the verdicts unit tests pin (`LOG_PAYLOAD_VECTOR`).
fn sample_log() -> EvmLog {
    EvmLog {
        removed: false,
        log_index: 7,
        transaction_index: 3,
        transaction_hash: [0x11; 32],
        block_hash: [0x22; 32],
        block_number: 1234,
        address: [0x33; 20],
        data: "0x0102".to_string(),
        topics: vec![[0x44; 32], [0x55; 32]],
    }
}

const LOG_PAYLOAD_VECTOR: &str = "038c130fc6cc258dd4176800f12e7f7f19f9fc36baf9884812d49a727d621499";

#[tokio::test]
async fn foreign_events() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let verdicts = env.verdicts.id().as_str();
    let log = sample_log();
    let hash = foreign_payload_hash("base", &log);
    assert_eq!(hex::encode(hash), LOG_PAYLOAD_VECTOR);
    let claim = |log: &EvmLog, subject: Option<&str>| {
        json!({
            "chain": "base", "tx_id": format!("0x{}", hex::encode(log.transaction_hash)),
            "log_index": log.log_index, "log": log.json(), "subject": subject,
        })
    };
    let respond = |response: Option<Value>| {
        env.owner.call(env.mpc.id(), "set_response").args_json(json!({ "response": response })).transact()
    };
    let request = |claim: Value, deposit: u128| {
        env.relayer
            .call(env.verdicts.id(), "attest_foreign_event")
            .args_json(json!({ "claim": claim }))
            .deposit(yocto(deposit))
            .gas(TX_GAS)
            .transact()
    };
    let deposit = event_deposit(&env, claim(&log, None)).await?;
    assert!(deposit > 0);
    let count = env.attestation_count().await?;

    // Failures end as `failed` with no attestation: no answer, a wrong key, a wrong hash.
    let other_hash = sha256(b"another payload");
    let cases = [
        (None, "the MPC call failed or timed out"),
        (
            Some(
                json!({ "payload_hash": hex::encode(hash), "signature": mpc_signature(&secp_key(99), &hash) }),
            ),
            "invalid MPC signature",
        ),
        (
            Some(
                json!({ "payload_hash": hex::encode(other_hash), "signature": mpc_signature(&env.keys.mpc, &other_hash) }),
            ),
            "the MPC signed another payload hash",
        ),
    ];
    for (response, reason) in cases {
        let _ = ok(respond(response).await?);
        let start = env.balance(&env.relayer).await?;
        let result = request(claim(&log, None), deposit).await?;
        assert!(result.is_success(), "{:#?}", result.failures());
        // The whole deposit came back: the relayer paid only gas.
        let burnt: u128 = result.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear()).sum();
        assert_eq!(start - env.balance(&env.relayer).await?, burnt, "{reason}");
        assert_eq!(result.clone().json::<Value>()?, json!({ "uid": hex::encode(hash), "status": "failed" }));
        assert_eq!(event(&result, "foreign_tx_requested")["payload_hash"], hex::encode(hash));
        assert_eq!(event(&result, "foreign_tx_failed")["reason"], reason);
        assert!(events(&result, "foreign_tx_verified").is_empty());
        assert_eq!(env.attestation_count().await?, count);
        let attested: bool = env
            .view(&env.verdicts, "is_event_attested", json!({ "payload_hash": hex::encode(hash) }))
            .await?;
        assert!(!attested);
    }

    // The MPC signs the expected hash with the configured key: a foreign_tx attestation.
    let _ = ok(respond(Some(
        json!({ "payload_hash": hex::encode(hash), "signature": mpc_signature(&env.keys.mpc, &hash) }),
    ))
    .await?);
    fails_with(request(claim(&log, None), deposit - 1).await?, "attach at least");
    let before = env.storage(&env.attestations, env.verdicts.id()).await?.expect("registered");
    let result = ok(request(claim(&log, None), deposit).await?);
    let after = env.storage(&env.attestations, env.verdicts.id()).await?.expect("registered");
    assert!(after.1 >= before.1, "the verdicts storage balance went from {before:?} to {after:?}");
    let outcome: Value = result.clone().json()?;
    assert_eq!(outcome["status"], "created");
    let subject = format!("eip155:8453:0x{}", hex::encode(log.address));
    let verified = event(&result, "foreign_tx_verified");
    assert_eq!(verified["subject"], subject);
    assert_eq!(verified["block_number"], 1234);
    let data = foreign_attestation_data("base", &log);
    let uid = attestation_uid(&env.verdict_schemas.foreign_tx, &subject, verdicts, &data, 0);
    assert_eq!(outcome["uid"], uid);
    let a = env.attestation(&uid).await?.expect("stored");
    assert_eq!(a["schema_uid"], env.verdict_schemas.foreign_tx);
    assert_eq!(a["attester"], verdicts);
    assert_eq!(a["subject"], subject);
    assert_eq!(a["data"], b64(&data));
    let attested: bool =
        env.view(&env.verdicts, "is_event_attested", json!({ "payload_hash": hex::encode(hash) })).await?;
    assert!(attested);

    // What the MPC was asked for.
    let asked: Value = env.view(&env.mpc, "last_request", json!({})).await?;
    assert_eq!(
        asked,
        json!({
            "request": { "Base": {
                "tx_id": hex::encode(log.transaction_hash),
                "extractors": [{ "Log": { "log_index": 7 } }],
                "finality": "Finalized",
            }},
            "domain_id": 3,
            "payload_version": 1,
            "expected_payload_hash": hex::encode(hash),
        })
    );
    let mpc_deposit: String = env.view(&env.mpc, "last_deposit", json!({})).await?;
    assert_eq!(mpc_deposit, "1");

    // Each event is attested once.
    fails_with(request(claim(&log, None), deposit).await?, "this event was already attested");

    // Another log of the same transaction, attested to a chosen subject.
    let mut second = log.clone();
    second.log_index = 8;
    let hash2 = foreign_payload_hash("base", &second);
    let _ = ok(respond(Some(
        json!({ "payload_hash": hex::encode(hash2), "signature": mpc_signature(&env.keys.mpc, &hash2) }),
    ))
    .await?);
    let second_deposit = event_deposit(&env, claim(&second, Some("bob.test.near"))).await?;
    let result = ok(request(claim(&second, Some("bob.test.near")), second_deposit).await?);
    let outcome: Value = result.json()?;
    assert_eq!(outcome["status"], "created");
    let a = env.attestation(outcome["uid"].as_str().expect("uid")).await?.expect("stored");
    assert_eq!(a["subject"], "bob.test.near");
    assert_eq!(env.attestation_count().await?, count + 2);
    Ok(())
}

const INSTRUCTION_SCHEMA: &str = "string chain, bytes tx_id, u64 instruction_index, u64 inner_instruction_index, bytes32 program_id, bytes32[] accounts, bytes data";

#[tokio::test]
async fn solana_instructions() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let verdicts = env.verdicts.id().as_str();
    let schema = env.schema(&env.owner, INSTRUCTION_SCHEMA, None, true).await?;
    let _ = ok(env
        .owner
        .call(env.verdicts.id(), "set_instruction_schema")
        .args_json(json!({ "uid": schema }))
        .deposit(yocto(1))
        .transact()
        .await?);

    let (tx, program, accounts, data) =
        ([0x11u8; 64], [0x33u8; 32], vec![[0x44u8; 32], [0x55u8; 32]], vec![3u8, 1, 0, 0]);
    let b58 = |b: &[u8]| bs58::encode(b).into_string();
    let claim = json!({
        "tx_id": b58(&tx), "instruction_index": 2, "inner_instruction_index": 0,
        "program_id": b58(&program), "accounts": accounts.iter().map(|a| b58(a)).collect::<Vec<_>>(),
        "data": b58(&data), "subject": null,
    });
    let hash = instruction_payload_hash(&tx, 2, 0, &program, &accounts, &data);
    let _ = ok(env
        .owner
        .call(env.mpc.id(), "set_response")
        .args_json(json!({ "response": { "payload_hash": hex::encode(hash), "signature": mpc_signature(&env.keys.mpc, &hash) } }))
        .transact()
        .await?);
    let deposit: String =
        env.view(&env.verdicts, "foreign_instruction_deposit", json!({ "claim": claim })).await?;
    let result = ok(env
        .relayer
        .call(env.verdicts.id(), "attest_foreign_instruction")
        .args_json(json!({ "claim": claim }))
        .deposit(yocto(deposit.parse()?))
        .gas(TX_GAS)
        .transact()
        .await?);
    let outcome: Value = result.clone().json()?;
    assert_eq!(outcome["status"], "created", "{outcome}");
    // The sandbox MPC double is not a .testnet account, so the subject names Solana mainnet.
    let subject = format!("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:{}", b58(&program));
    assert_eq!(event(&result, "foreign_tx_verified")["subject"], subject);
    let a = env.attestation(outcome["uid"].as_str().expect("uid")).await?.expect("stored");
    assert_eq!(a["schema_uid"], schema);
    assert_eq!(a["attester"], verdicts);
    assert_eq!(a["subject"], subject);
    let stored = borsh::to_vec(&("solana", tx.to_vec(), 2u64, 0u64, program, accounts.clone(), data.clone()));
    assert_eq!(a["data"], b64(&stored?));

    let asked: Value = env.view(&env.mpc, "last_request", json!({})).await?;
    assert_eq!(asked["request"]["Solana"]["tx_id"], hex::encode(tx));
    assert_eq!(
        asked["request"]["Solana"]["extractors"],
        json!([{ "InnerInstruction": { "instruction_index": 2, "inner_instruction_index": 0 } }])
    );
    assert_eq!(asked["expected_payload_hash"], hex::encode(hash));
    fails_with(
        env.relayer
            .call(env.verdicts.id(), "attest_foreign_instruction")
            .args_json(json!({ "claim": claim }))
            .deposit(yocto(deposit.parse()?))
            .gas(TX_GAS)
            .transact()
            .await?,
        "this instruction was already attested",
    );
    Ok(())
}

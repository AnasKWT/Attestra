//! Attest and revoke without a resolver, expiry, non-revocable schemas, and resolvers that refuse
//! a revocation.

use attestra_sandbox_tests::crypto::{attestation_uid, b64};
use attestra_sandbox_tests::util::{
    advance_past, chain_secs, event, events, fails_with, millinear, ok, TX_GAS,
};
use attestra_sandbox_tests::Env;
use serde_json::{json, Value};

#[tokio::test]
async fn attest_revoke_and_expiry() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, bob) = (&env.alice, &env.bob);
    let schema = env.schema(alice, "string name, u8 level", None, true).await?;
    let fixed = env.schema(alice, "string name", None, false).await?;

    // Attest: the UID is derived from the inputs and the attester's nonce.
    let data = b"\x05\x00\x00\x00Alice\x07".to_vec();
    let (outcome, result) = env.attest_ok(alice, &schema, bob.id().as_str(), &data).await?;
    let uid = attestation_uid(&schema, bob.id().as_str(), alice.id().as_str(), &data, 0);
    assert_eq!(outcome, json!({ "uid": uid, "status": "created" }));
    let created = event(&result, "attestation_created");
    assert_eq!(created["uid"], uid);
    assert_eq!(created["attester"], alice.id().as_str());
    assert_eq!(created["actor"], alice.id().as_str());
    assert_eq!(created["subject"], bob.id().as_str());
    assert_eq!(created["nonce"], 0);
    let a = env.attestation(&uid).await?.expect("stored");
    assert_eq!(a["status"], "active");
    assert_eq!(a["attester"], alice.id().as_str());
    assert_eq!(a["data"], b64(&data));
    assert_eq!(a["schema_uid"], schema);
    assert!(a["created_at"].as_u64().expect("u64") > 0);
    assert!(env.view::<bool>(&env.attestations, "is_valid", json!({ "uid": uid })).await?);
    assert_eq!(
        env.view::<u64>(&env.attestations, "get_nonce", json!({ "account_id": alice.id() })).await?,
        1
    );
    let count = env.attestation_count().await?;

    // A CAIP-10 subject is accepted; anything else is not.
    let caip = "eip155:1:0xab5801a7d398351b8be11c439e05c5b3259aec9b";
    let (caip_outcome, _) = env.attest_ok(alice, &schema, caip, &data).await?;
    assert_eq!(caip_outcome["uid"], attestation_uid(&schema, caip, alice.id().as_str(), &data, 1));
    let bad = env.attest(alice, &schema, "Not An Account", &data, None, millinear(100)).await?;
    fails_with(bad, "subject must be a NEAR account id or a CAIP-10 account id");
    let unknown = env.attest(alice, &"00".repeat(32), "bob.test.near", &data, None, millinear(100)).await?;
    fails_with(unknown, "unknown schema");
    assert_eq!(env.attestation_count().await?, count + 1);

    // Revoke: only the attester, only once.
    fails_with(env.revoke(bob, &uid).await?, "only the attester can revoke");
    let revoked = ok(env.revoke(alice, &uid).await?);
    assert_eq!(revoked.clone().json::<Value>()?, json!({ "uid": uid, "status": "revoked" }));
    let e = event(&revoked, "attestation_revoked");
    assert_eq!(e["revoker"], alice.id().as_str());
    assert_eq!(e["scheduled"], false);
    let a = env.attestation(&uid).await?.expect("stored");
    assert_eq!(a["status"], "revoked");
    assert_eq!(a["revoked"], true);
    assert!(a["revocation_time"].as_u64().expect("u64") > 0);
    assert!(!env.view::<bool>(&env.attestations, "is_valid", json!({ "uid": uid })).await?);
    fails_with(env.revoke(alice, &uid).await?, "already revoked");

    // Expiry is computed on every read.
    let now = chain_secs(&env.worker).await?;
    let past =
        env.attest(alice, &schema, bob.id().as_str(), &data, Some(now.saturating_sub(10)), millinear(100));
    fails_with(past.await?, "expiration_time must be in the future");
    let expires_at = now + 4;
    let expiring =
        ok(env.attest(alice, &schema, bob.id().as_str(), b"exp", Some(expires_at), millinear(100)).await?);
    let expiring_uid = expiring.json::<Value>()?["uid"].as_str().expect("uid").to_string();
    let a = env.attestation(&expiring_uid).await?.expect("stored");
    assert_eq!(a["status"], "active");
    assert_eq!(a["expiration_time"], expires_at);
    advance_past(&env.worker, expires_at).await?;
    let a = env.attestation(&expiring_uid).await?.expect("stored");
    assert_eq!(a["status"], "expired");
    assert!(!env.view::<bool>(&env.attestations, "is_valid", json!({ "uid": expiring_uid })).await?);

    // A non-revocable schema refuses revocation.
    let (kept, _) = env.attest_ok(alice, &fixed, bob.id().as_str(), b"\x01\x00\x00\x00k").await?;
    let kept_uid = kept["uid"].as_str().expect("uid");
    fails_with(env.revoke(alice, kept_uid).await?, "the schema is not revocable");
    assert_eq!(env.attestation(kept_uid).await?.expect("stored")["status"], "active");
    Ok(())
}

#[tokio::test]
async fn resolver_refusing_revocation() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, bob) = (&env.alice, &env.bob);

    // The double approves attestations and refuses revocations.
    let schema = env.schema(alice, "string note", Some(env.toggle.id()), true).await?;
    let (outcome, result) = env.attest_ok(alice, &schema, bob.id().as_str(), b"\x02\x00\x00\x00hi").await?;
    assert_eq!(outcome["status"], "created");
    assert_eq!(events(&result, "attestation_pending").len(), 1);
    assert_eq!(events(&result, "attestation_created").len(), 1);
    let uid = outcome["uid"].as_str().expect("uid").to_string();
    let counts: Value = env.view(&env.toggle, "get_counts", json!({})).await?;
    assert_eq!(counts["committed"], 1);

    let _ = ok(env
        .owner
        .call(env.toggle.id(), "set_answers")
        .args_json(json!({ "answers": { "schema": true, "attest": true, "revoke": false } }))
        .transact()
        .await?);
    let refused = ok(env.revoke(alice, &uid).await?);
    assert_eq!(refused.clone().json::<Value>()?, json!({ "uid": uid, "status": "refused" }));
    assert_eq!(event(&refused, "revocation_rejected")["resolver"], env.toggle.id().as_str());
    assert!(events(&refused, "attestation_revoked").is_empty());
    let a = env.attestation(&uid).await?.expect("stored");
    assert_eq!(a["status"], "active");
    assert_eq!(a["revoked"], false);

    // A scheduled revocation is refused the same way.
    let at = chain_secs(&env.worker).await? + 60;
    let scheduled = ok(alice
        .call(env.attestations.id(), "schedule_revocation")
        .args_json(json!({ "uid": uid, "revoke_at": at }))
        .gas(TX_GAS)
        .transact()
        .await?);
    assert_eq!(scheduled.json::<Value>()?["status"], "refused");
    assert_eq!(env.attestation(&uid).await?.expect("stored")["revoke_at"], 0);

    // Once the resolver approves, the revocation goes through.
    let _ = ok(env
        .owner
        .call(env.toggle.id(), "set_answers")
        .args_json(json!({ "answers": { "schema": true, "attest": true, "revoke": true } }))
        .transact()
        .await?);
    let revoked = ok(env.revoke(alice, &uid).await?);
    assert_eq!(revoked.json::<Value>()?["status"], "revoked");
    assert_eq!(env.attestation(&uid).await?.expect("stored")["status"], "revoked");

    // A real pipeline refuses when one of its resolvers fails: the whitelist stops trusting the
    // pipeline after the attestation was made.
    let piped = env.schema(alice, "string piped", Some(env.pipeline.id()), true).await?;
    let _ = ok(alice
        .call(env.pipeline.id(), "set_pipeline")
        .args_json(json!({ "schema_uid": piped, "resolvers": [env.whitelist.id()] }))
        .deposit(millinear(50))
        .gas(TX_GAS)
        .transact()
        .await?);
    let _ = ok(alice
        .call(env.whitelist.id(), "whitelist_add")
        .args_json(json!({ "schema_uid": piped, "account_id": alice.id() }))
        .deposit(millinear(10))
        .gas(TX_GAS)
        .transact()
        .await?);
    let (outcome, _) = env.attest_ok(alice, &piped, bob.id().as_str(), b"\x01\x00\x00\x00p").await?;
    assert_eq!(outcome["status"], "created");
    let piped_uid = outcome["uid"].as_str().expect("uid").to_string();
    let _ = ok(env
        .owner
        .call(env.whitelist.id(), "remove_trusted_pipeline")
        .args_json(json!({ "account_id": env.pipeline.id() }))
        .transact()
        .await?);
    let refused = env.revoke(alice, &piped_uid).await?;
    assert!(refused.is_success());
    assert_eq!(refused.clone().json::<Value>()?["status"], "refused");
    assert_eq!(env.attestation(&piped_uid).await?.expect("stored")["status"], "active");
    Ok(())
}

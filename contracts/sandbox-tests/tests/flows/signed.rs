//! NEP-413 signed requests submitted by a relayer.

use attestra_sandbox_tests::crypto::{b64, ed_key, implicit_account, near_public_key, signed_request};
use attestra_sandbox_tests::util::{chain_secs, event, fails_with, millinear, ok, yocto, TX_GAS};
use attestra_sandbox_tests::Env;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

async fn submit(env: &Env, request: &Value, deposit: NearToken) -> anyhow::Result<ExecutionFinalResult> {
    Ok(env
        .relayer
        .call(env.attestations.id(), "submit_signed")
        .args_json(json!({ "request": request }))
        .deposit(deposit)
        .gas(TX_GAS)
        .transact()
        .await?)
}

fn attest_message(attester: &str, schema: &str, subject: &str, data: &[u8], deadline: u64) -> String {
    json!({
        "action": "attest", "attester": attester, "schema_uid": schema, "subject": subject,
        "data": b64(data), "expiration_time": null, "ref_uid": null, "deadline": deadline,
    })
    .to_string()
}

#[tokio::test]
async fn nep413_signed_requests() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, relayer) = (&env.alice, &env.relayer);
    let recipient = env.attestations.id().as_str();
    let schema = env.schema(alice, "string signed_claim", None, true).await?;

    // Alice registers a signer key and keeps a storage balance the requests spend.
    let key = ed_key(10);
    let added = ok(alice
        .call(env.attestations.id(), "add_signer_key")
        .args_json(json!({ "public_key": near_public_key(&key) }))
        .deposit(millinear(500))
        .transact()
        .await?);
    assert_eq!(event(&added, "signer_key_added")["public_key"], near_public_key(&key));
    let keys: Vec<String> =
        env.view(&env.attestations, "get_signer_keys", json!({ "account_id": alice.id() })).await?;
    assert_eq!(keys, vec![near_public_key(&key)]);

    let deadline = chain_secs(&env.worker).await? + 600;
    let message = attest_message(alice.id().as_str(), &schema, "bob.test.near", b"signed", deadline);
    let request = signed_request(&key, &message, [7; 32], recipient);
    let storage_before = env.storage(&env.attestations, alice.id()).await?.expect("registered");
    let relayer_storage = env.storage(&env.attestations, relayer.id()).await?;
    let created = ok(submit(&env, &request, yocto(0)).await?);
    let outcome: Value = created.clone().json()?;
    assert_eq!(outcome["status"], "created");
    let e = event(&created, "attestation_created");
    assert_eq!(e["attester"], alice.id().as_str());
    assert_eq!(e["actor"], relayer.id().as_str());
    let uid = outcome["uid"].as_str().expect("uid").to_string();
    assert_eq!(env.attestation(&uid).await?.expect("stored")["attester"], alice.id().as_str());
    // Alice's balance paid; the relayer paid nothing but gas.
    let storage_after = env.storage(&env.attestations, alice.id()).await?.expect("registered");
    assert_eq!(storage_after.0, storage_before.0);
    assert!(storage_after.1 < storage_before.1);
    assert_eq!(env.storage(&env.attestations, relayer.id()).await?, relayer_storage);

    // The same request again is a replay.
    fails_with(submit(&env, &request, yocto(0)).await?, "this signed request was already used");

    // A tampered message no longer matches the signature.
    let mut tampered = signed_request(&key, &message, [8; 32], recipient);
    tampered["message"] =
        json!(attest_message(alice.id().as_str(), &schema, "carol.test.near", b"signed", deadline));
    fails_with(submit(&env, &tampered, yocto(0)).await?, "invalid signature");
    // A signature for another recipient is invalid here.
    let elsewhere = signed_request(&key, &message, [9; 32], "other.test.near");
    fails_with(submit(&env, &elsewhere, yocto(0)).await?, "invalid signature");
    // A key alice never registered.
    let stranger = signed_request(&ed_key(12), &message, [10; 32], recipient);
    fails_with(submit(&env, &stranger, yocto(0)).await?, "the key is not a signer key of the attester");
    // An expired request.
    let stale = attest_message(alice.id().as_str(), &schema, "bob.test.near", b"late", deadline - 1200);
    fails_with(
        submit(&env, &signed_request(&key, &stale, [11; 32], recipient), yocto(0)).await?,
        "the signed request expired",
    );

    // A signed revocation.
    let revoke =
        json!({ "action": "revoke", "attester": alice.id(), "uid": uid, "deadline": deadline }).to_string();
    let revoked = ok(submit(&env, &signed_request(&key, &revoke, [12; 32], recipient), yocto(0)).await?);
    assert_eq!(revoked.clone().json::<Value>()?, json!({ "uid": uid, "status": "revoked" }));
    assert_eq!(event(&revoked, "attestation_revoked")["revoker"], relayer.id().as_str());
    assert_eq!(env.attestation(&uid).await?.expect("stored")["status"], "revoked");

    // An implicit account signs with the key its id is made of, with no registration. The
    // relayer's deposit is credited to the implicit account's storage balance.
    let implicit_key = ed_key(13);
    let implicit = implicit_account(&implicit_key);
    let message = attest_message(&implicit, &schema, "bob.test.near", b"implicit", deadline);
    let request = signed_request(&implicit_key, &message, [14; 32], recipient);
    fails_with(submit(&env, &request, yocto(0)).await?, "has no storage balance");
    let created = ok(submit(&env, &request, millinear(100)).await?);
    let outcome: Value = created.clone().json()?;
    assert_eq!(outcome["status"], "created");
    assert_eq!(event(&created, "attestation_created")["attester"], implicit);
    let a = env.attestation(outcome["uid"].as_str().expect("uid")).await?.expect("stored");
    assert_eq!(a["attester"], implicit);
    assert!(env.storage(&env.attestations, &implicit.parse()?).await?.is_some());
    // Another key cannot sign for it.
    let forged = signed_request(&ed_key(15), &message, [16; 32], recipient);
    fails_with(submit(&env, &forged, millinear(100)).await?, "the key is not a signer key of the attester");
    Ok(())
}

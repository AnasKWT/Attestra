//! Credentials minted from attestations and burned on revoke, and scheduled revocations.

use attestra_sandbox_tests::util::{
    advance_past, chain_secs, event, events, fails_with, millinear, nep297, ok, yocto, TX_GAS,
};
use attestra_sandbox_tests::Env;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::Account;
use serde_json::{json, Value};

async fn mint(env: &Env, who: &Account, uid: &str, deposit: u128) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.credentials.id(), "mint")
        .args_json(json!({ "attestation_uid": uid }))
        .deposit(yocto(deposit))
        .gas(TX_GAS)
        .transact()
        .await?)
}

async fn credential(env: &Env, uid: &str) -> anyhow::Result<Option<Value>> {
    env.view(&env.credentials, "credential_for_attestation", json!({ "attestation_uid": uid })).await
}

async fn supply(env: &Env) -> anyhow::Result<String> {
    env.view(&env.credentials, "nft_total_supply", json!({})).await
}

#[tokio::test]
async fn credential_lifecycle() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, bob, carol) = (&env.alice, &env.bob, &env.carol);
    let schema = env.schema(alice, "string course", None, true).await?;
    let (outcome, _) = env.attest_ok(alice, &schema, bob.id().as_str(), b"\x04\x00\x00\x00rust").await?;
    let uid = outcome["uid"].as_str().expect("uid").to_string();
    let a = env.attestation(&uid).await?.expect("stored");

    // The subject mints; the deposit pays the storage and the rest comes back.
    let before = env.balance(bob).await?;
    let minted = ok(mint(&env, bob, &uid, millinear(100).as_yoctonear()).await?);
    let burnt: u128 = minted.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear()).sum();
    let token: Value = minted.clone().json()?;
    assert_eq!(token["token_id"], uid);
    assert_eq!(token["owner_id"], bob.id().as_str());
    let e = event(&minted, "credential_minted");
    assert_eq!(e["attestation_uid"], uid);
    assert_eq!(e["minter"], bob.id().as_str());
    assert_eq!(e["attester"], alice.id().as_str());
    let nft_mint = nep297(&minted, "nep171", "nft_mint");
    assert_eq!(nft_mint.len(), 1);
    assert_eq!(nft_mint[0]["owner_id"], bob.id().as_str());
    let spent = before - env.balance(bob).await? - burnt;
    assert!(spent > 0 && spent < millinear(20).as_yoctonear(), "the credential storage cost {spent}");

    // NEP-171, NEP-177 and NEP-181 views.
    let nft: Value = env.view(&env.credentials, "nft_token", json!({ "token_id": uid })).await?;
    assert_eq!(nft["owner_id"], bob.id().as_str());
    let metadata = &nft["metadata"];
    assert_eq!(metadata["title"], "Attestra credential");
    assert_eq!(metadata["issued_at"], (a["created_at"].as_u64().expect("u64") * 1000).to_string());
    assert_eq!(metadata["expires_at"], Value::Null);
    let extra: Value = serde_json::from_str(metadata["extra"].as_str().expect("extra"))?;
    assert_eq!(extra, json!({ "schema_uid": schema, "attester": alice.id(), "attestation_uid": uid }));
    assert_eq!(credential(&env, &uid).await?.expect("minted")["token_id"], uid);
    assert_eq!(supply(&env).await?, "1");
    let owned: String =
        env.view(&env.credentials, "nft_supply_for_owner", json!({ "account_id": bob.id() })).await?;
    assert_eq!(owned, "1");
    let tokens: Vec<Value> =
        env.view(&env.credentials, "nft_tokens_for_owner", json!({ "account_id": bob.id() })).await?;
    assert_eq!(tokens.len(), 1);
    let all: Vec<Value> = env.view(&env.credentials, "nft_tokens", json!({})).await?;
    assert_eq!(all.len(), 1);
    let contract: Value = env.view(&env.credentials, "nft_metadata", json!({})).await?;
    assert_eq!(contract["symbol"], "ATTEST");
    assert_eq!(contract["spec"], "nft-1.0.0");
    let approved: bool = env
        .view(
            &env.credentials,
            "nft_is_approved",
            json!({ "token_id": uid, "approved_account_id": carol.id() }),
        )
        .await?;
    assert!(!approved);

    // Non-transferable, and one credential per attestation.
    let transfer = bob
        .call(env.credentials.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": carol.id(), "token_id": uid }))
        .deposit(yocto(1))
        .transact()
        .await?;
    fails_with(transfer, "credentials are non-transferable");
    fails_with(mint(&env, alice, &uid, millinear(100).as_yoctonear()).await?, "a credential already exists");

    // Refused in the callback: the whole deposit is refunded and nothing is minted.
    let (other, _) = env.attest_ok(alice, &schema, bob.id().as_str(), b"other").await?;
    let other_uid = other["uid"].as_str().expect("uid");
    let refused = ok(mint(&env, carol, other_uid, millinear(100).as_yoctonear()).await?);
    assert_eq!(refused.clone().json::<Value>()?, Value::Null);
    assert!(refused.logs().iter().any(|l| l.contains("is neither the attester nor the subject")));
    assert!(events(&refused, "credential_minted").is_empty());
    let short = ok(mint(&env, alice, other_uid, 1).await?);
    assert_eq!(short.clone().json::<Value>()?, Value::Null);
    assert!(short.logs().iter().any(|l| l.contains("to cover the storage")));
    assert!(credential(&env, other_uid).await?.is_none());
    let missing = ok(mint(&env, bob, &"ab".repeat(32), millinear(100).as_yoctonear()).await?);
    assert!(missing.logs().iter().any(|l| l.contains("the attestation does not exist")));

    // Revoking burns it.
    let revoked = ok(env.revoke(alice, &uid).await?);
    let burned = event(&revoked, "credential_burned");
    assert_eq!(burned["attestation_uid"], uid);
    assert_eq!(burned["owner_id"], bob.id().as_str());
    assert_eq!(nep297(&revoked, "nep171", "nft_burn").len(), 1);
    assert!(credential(&env, &uid).await?.is_none());
    assert_eq!(supply(&env).await?, "0");
    let late = ok(mint(&env, bob, &uid, millinear(100).as_yoctonear()).await?);
    assert!(late.logs().iter().any(|l| l.contains("the attestation is revoked")));
    Ok(())
}

#[tokio::test]
async fn scheduled_revocation() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, bob) = (&env.alice, &env.bob);
    let schema = env.schema(alice, "string membership", None, true).await?;
    let (outcome, _) = env.attest_ok(alice, &schema, bob.id().as_str(), b"\x03\x00\x00\x00pro").await?;
    let uid = outcome["uid"].as_str().expect("uid").to_string();
    let _ = ok(mint(&env, bob, &uid, millinear(100).as_yoctonear()).await?);
    assert!(credential(&env, &uid).await?.is_some());

    let now = chain_secs(&env.worker).await?;
    let schedule = |at: u64| {
        alice
            .call(env.attestations.id(), "schedule_revocation")
            .args_json(json!({ "uid": uid, "revoke_at": at }))
            .gas(TX_GAS)
            .transact()
    };
    fails_with(schedule(now.saturating_sub(5)).await?, "revoke_at must be in the future");
    let revoke_at = now + 5;
    let scheduled = ok(schedule(revoke_at).await?);
    assert_eq!(scheduled.clone().json::<Value>()?, json!({ "uid": uid, "status": "scheduled" }));
    assert_eq!(event(&scheduled, "revocation_scheduled")["revoke_at"], revoke_at);
    let a = env.attestation(&uid).await?.expect("stored");
    assert_eq!(a["status"], "active");
    assert_eq!(a["revoke_at"], revoke_at);
    let finalize = || {
        env.relayer
            .call(env.attestations.id(), "finalize_revocation")
            .args_json(json!({ "uid": uid }))
            .gas(TX_GAS)
            .transact()
    };
    fails_with(finalize().await?, "no revocation is due");

    // Once the time passes it reads as revoked with no transaction; the credential stays until
    // the revocation is finalized.
    advance_past(&env.worker, revoke_at).await?;
    let a = env.attestation(&uid).await?.expect("stored");
    assert_eq!(a["status"], "revoked");
    assert_eq!(a["revoked"], true);
    assert_eq!(a["revocation_time"], revoke_at);
    assert!(!env.view::<bool>(&env.attestations, "is_valid", json!({ "uid": uid })).await?);
    fails_with(env.revoke(alice, &uid).await?, "already revoked");
    assert!(credential(&env, &uid).await?.is_some());

    // Anyone finalizes it: the event is written and the credential burned.
    let finalized = ok(finalize().await?);
    assert_eq!(finalized.clone().json::<Value>()?, json!({ "uid": uid, "status": "revoked" }));
    let e = event(&finalized, "attestation_revoked");
    assert_eq!(e["scheduled"], true);
    assert_eq!(e["revoker"], alice.id().as_str());
    assert_eq!(event(&finalized, "credential_burned")["attestation_uid"], uid);
    assert!(credential(&env, &uid).await?.is_none());
    fails_with(finalize().await?, "already revoked");
    Ok(())
}

/// A revocation sent while a mint is on its way: whichever lands first, no credential survives
/// for a revoked attestation. The mint and the revocation are sent at a few offsets so some runs
/// reach the window where the mint already read the attestation as active.
#[tokio::test]
async fn revocation_during_a_mint() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, bob) = (&env.alice, &env.bob);
    let schema = env.schema(alice, "string race", None, true).await?;
    let mut reasons = Vec::new();
    for delay_ms in [0u64, 100, 200, 400, 800] {
        let data = format!("race {delay_ms}");
        let (outcome, _) = env.attest_ok(alice, &schema, bob.id().as_str(), data.as_bytes()).await?;
        let uid = outcome["uid"].as_str().expect("uid").to_string();
        let mint = bob
            .call(env.credentials.id(), "mint")
            .args_json(json!({ "attestation_uid": uid }))
            .deposit(millinear(100))
            .gas(TX_GAS)
            .transact_async()
            .await?;
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        let revoke = alice
            .call(env.attestations.id(), "revoke")
            .args_json(json!({ "uid": uid }))
            .gas(TX_GAS)
            .transact_async()
            .await?;
        let (minted, revoked) = (mint.await?, ok(revoke.await?));
        assert!(minted.is_success(), "{:#?}", minted.failures());
        assert_eq!(revoked.json::<Value>()?["status"], "revoked");
        let reason = minted
            .logs()
            .iter()
            .find_map(|l| l.strip_prefix("credential not minted: ").map(str::to_string))
            .unwrap_or_else(|| "minted, then burned".to_string());
        assert!(credential(&env, &uid).await?.is_none(), "a credential survived ({reason})");
        reasons.push(reason);
    }
    println!("mint and revoke outcomes: {reasons:?}");
    assert_eq!(supply(&env).await?, "0");
    Ok(())
}

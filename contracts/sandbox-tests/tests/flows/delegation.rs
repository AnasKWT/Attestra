//! Delegates acting within a scope, and k-of-n multisig authorities.

use attestra_sandbox_tests::crypto::b64;
use attestra_sandbox_tests::util::{event, fails_with, millinear, ok, TX_GAS};
use attestra_sandbox_tests::Env;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::Account;
use serde_json::{json, Value};

async fn on_behalf(
    env: &Env,
    delegate: &Account,
    authority: &Account,
    schema: &str,
    data: &[u8],
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(delegate
        .call(env.attestations.id(), "attest_on_behalf")
        .args_json(json!({
            "authority": authority.id(), "schema_uid": schema, "subject": "carol.test.near",
            "data": b64(data), "expiration_time": null, "ref_uid": null,
        }))
        .gas(TX_GAS)
        .transact()
        .await?)
}

async fn revoke_on_behalf(env: &Env, delegate: &Account, uid: &str) -> anyhow::Result<ExecutionFinalResult> {
    Ok(delegate
        .call(env.attestations.id(), "revoke_on_behalf")
        .args_json(json!({ "uid": uid }))
        .gas(TX_GAS)
        .transact()
        .await?)
}

#[tokio::test]
async fn delegation() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, bob, dave) = (&env.alice, &env.bob, &env.dave);
    let scoped = env.schema(alice, "string scoped", None, true).await?;
    let other = env.schema(alice, "string other", None, true).await?;

    // Bob may attest under one schema, twice, and may not revoke. The deposit attached here is
    // credited to alice's storage balance, which pays for what bob creates.
    let added = ok(alice
        .call(env.attestations.id(), "add_delegate")
        .args_json(json!({ "delegate": bob.id(), "scope": { "schemas": [scoped], "max_uses": 2, "can_revoke": false, "label": "ops" } }))
        .deposit(millinear(500))
        .transact()
        .await?);
    let e = event(&added, "delegate_added");
    assert_eq!(e["delegate"], bob.id().as_str());
    assert_eq!(e["max_uses"], 2);
    assert!(
        env.view::<bool>(
            &env.attestations,
            "is_delegate",
            json!({ "authority": alice.id(), "delegate": bob.id() })
        )
        .await?
    );

    let created = ok(on_behalf(&env, bob, alice, &scoped, b"one").await?);
    let outcome: Value = created.clone().json()?;
    assert_eq!(outcome["status"], "created");
    let e = event(&created, "attestation_created");
    assert_eq!(e["attester"], alice.id().as_str());
    assert_eq!(e["actor"], bob.id().as_str());
    let uid = outcome["uid"].as_str().expect("uid").to_string();
    assert_eq!(env.attestation(&uid).await?.expect("stored")["attester"], alice.id().as_str());

    fails_with(
        on_behalf(&env, bob, alice, &other, b"out").await?,
        "the schema is outside the delegation's scope",
    );
    fails_with(revoke_on_behalf(&env, bob, &uid).await?, "the delegation does not allow revoking");
    let _ = ok(on_behalf(&env, bob, alice, &scoped, b"two").await?);
    fails_with(on_behalf(&env, bob, alice, &scoped, b"three").await?, "the delegation has no uses left");
    let view: Value = env
        .view(&env.attestations, "get_delegate", json!({ "authority": alice.id(), "delegate": bob.id() }))
        .await?;
    assert_eq!(view["uses"], 2);
    assert_eq!(view["active"], false);
    fails_with(on_behalf(&env, dave, alice, &scoped, b"stranger").await?, "not a delegate of this authority");

    // Dave may revoke under any schema.
    let _ = ok(alice
        .call(env.attestations.id(), "add_delegate")
        .args_json(json!({ "delegate": dave.id(), "scope": { "can_revoke": true } }))
        .transact()
        .await?);
    let delegates: Vec<Value> =
        env.view(&env.attestations, "get_delegates", json!({ "authority": alice.id() })).await?;
    assert_eq!(delegates.len(), 2);
    let revoked = ok(revoke_on_behalf(&env, dave, &uid).await?);
    assert_eq!(revoked.clone().json::<Value>()?, json!({ "uid": uid, "status": "revoked" }));
    assert_eq!(event(&revoked, "attestation_revoked")["revoker"], dave.id().as_str());
    assert_eq!(env.attestation(&uid).await?.expect("stored")["status"], "revoked");

    // Removed delegates can do nothing.
    let _ = ok(alice
        .call(env.attestations.id(), "remove_delegate")
        .args_json(json!({ "delegate": dave.id() }))
        .transact()
        .await?);
    fails_with(on_behalf(&env, dave, alice, &other, b"gone").await?, "not a delegate of this authority");
    Ok(())
}

#[tokio::test]
async fn multisig() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, bob, carol, dave) = (&env.alice, &env.bob, &env.carol, &env.dave);
    let schema = env.schema(alice, "string audit", None, true).await?;

    let created = ok(alice
        .call(env.attestations.id(), "create_multisig")
        .args_json(json!({ "members": [alice.id(), bob.id(), carol.id()], "threshold": 2, "metadata": "audit board" }))
        .deposit(millinear(500))
        .transact()
        .await?);
    let ms: String = created.clone().json()?;
    assert_eq!(ms, format!("ms-1.{}", env.attestations.id()));
    assert_eq!(event(&created, "multisig_created")["threshold"], 2);
    let authority: Value = env.view(&env.attestations, "get_authority", json!({ "account_id": ms })).await?;
    assert_eq!(authority["kind"], "multisig");

    // A member proposes (first approval), a second member approves and it executes.
    let propose = |who: &Account, action: Value| {
        who.call(env.attestations.id(), "propose")
            .args_json(json!({ "multisig_id": ms, "action": action }))
            .deposit(millinear(200))
            .gas(TX_GAS)
            .transact()
    };
    let approve = |who: &Account, id: u64| {
        who.call(env.attestations.id(), "approve")
            .args_json(json!({ "proposal_id": id }))
            .gas(TX_GAS)
            .transact()
    };
    let attest = json!({ "type": "attest", "schema_uid": schema, "subject": dave.id(), "data": b64(b"passed"), "expiration_time": null, "ref_uid": null });
    fails_with(propose(dave, attest.clone()).await?, "only members can propose");
    let proposed = ok(propose(alice, attest).await?);
    let id: u64 = proposed.clone().json()?;
    assert_eq!(event(&proposed, "multisig_proposed")["proposal_id"], id);
    fails_with(approve(alice, id).await?, "already approved");
    fails_with(approve(dave, id).await?, "only members can approve");
    let executed = ok(approve(bob, id).await?);
    let outcome: Value = executed.clone().json()?;
    assert_eq!(outcome["status"], "created");
    assert_eq!(event(&executed, "multisig_executed")["executor"], bob.id().as_str());
    let e = event(&executed, "attestation_created");
    assert_eq!(e["attester"], ms);
    assert_eq!(e["actor"], bob.id().as_str());
    let uid = outcome["uid"].as_str().expect("uid").to_string();
    assert_eq!(env.attestation(&uid).await?.expect("stored")["attester"], ms);
    let proposal: Value = env.view(&env.attestations, "get_proposal", json!({ "id": id })).await?;
    assert_eq!(proposal["status"], "executed");
    fails_with(approve(carol, id).await?, "the proposal is not open");

    // Only the multisig can revoke what it issued, by proposal.
    fails_with(env.revoke(alice, &uid).await?, "only the attester can revoke");
    let id: u64 = ok(propose(carol, json!({ "type": "revoke", "uid": uid })).await?).json()?;
    fails_with(env.revoke(bob, &uid).await?, "only the attester can revoke");
    let revoked = ok(approve(alice, id).await?);
    assert_eq!(revoked.clone().json::<Value>()?, json!({ "uid": uid, "status": "revoked" }));
    assert_eq!(event(&revoked, "attestation_revoked")["revoker"], alice.id().as_str());
    assert_eq!(env.attestation(&uid).await?.expect("stored")["status"], "revoked");
    Ok(())
}

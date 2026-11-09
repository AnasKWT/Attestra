//! NEP-145 storage at the attestations contract: paying as you go, a prepaid balance, withdraw
//! and unregister.

use attestra_sandbox_tests::util::{fails_with, millinear, near, ok, u128_of, yocto};
use attestra_sandbox_tests::Env;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::Account;
use serde_json::{json, Value};

/// 160 bytes at 10^19 yoctoNEAR per byte.
const MIN_STORAGE: u128 = 1_600_000_000_000_000_000_000;

fn burnt(result: &ExecutionFinalResult) -> u128 {
    result.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear()).sum()
}

async fn withdraw(
    env: &Env,
    who: &Account,
    amount: Option<u128>,
    deposit: u128,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.attestations.id(), "storage_withdraw")
        .args_json(json!({ "amount": amount.map(|a| a.to_string()) }))
        .deposit(yocto(deposit))
        .transact()
        .await?)
}

async fn unregister(env: &Env, who: &Account, force: bool) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who
        .call(env.attestations.id(), "storage_unregister")
        .args_json(json!({ "force": force }))
        .deposit(yocto(1))
        .transact()
        .await?)
}

#[tokio::test]
async fn storage_edges() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, carol, dave) = (&env.alice, &env.carol, &env.dave);
    let schema = env.schema(alice, "string stored", None, true).await?;
    let bounds: Value = env.view(&env.attestations, "storage_balance_bounds", json!({})).await?;
    assert_eq!(u128_of(&bounds["min"]), MIN_STORAGE);

    // No balance and no deposit: refused, nothing written.
    let count = env.attestation_count().await?;
    let refused = env.attest(carol, &schema, "bob.test.near", b"x", None, yocto(0)).await?;
    fails_with(refused, "has no storage balance; call storage_deposit or attach");
    let below = env.attest(carol, &schema, "bob.test.near", b"x", None, yocto(1)).await?;
    fails_with(below, "deposit below the storage registration minimum");
    assert_eq!(env.attestation_count().await?, count);
    assert_eq!(
        env.view::<u64>(&env.attestations, "get_nonce", json!({ "account_id": carol.id() })).await?,
        0
    );
    assert_eq!(env.storage(&env.attestations, carol.id()).await?, None);

    // A prepaid balance pays for later attestations.
    let deposited = ok(alice
        .call(env.attestations.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(near(1))
        .transact()
        .await?);
    let balance: Value = deposited.json()?;
    assert_eq!(u128_of(&balance["total"]), near(1).as_yoctonear());
    assert_eq!(u128_of(&balance["available"]), near(1).as_yoctonear() - MIN_STORAGE);
    // registration_only on a registered account sends the deposit back.
    let _ = ok(alice
        .call(env.attestations.id(), "storage_deposit")
        .args_json(json!({ "registration_only": true }))
        .deposit(millinear(10))
        .transact()
        .await?);
    assert_eq!(
        env.storage(&env.attestations, alice.id()).await?.expect("registered").0,
        near(1).as_yoctonear()
    );
    let (outcome, _) = env.attest_ok(alice, &schema, "bob.test.near", b"paid").await?;
    assert_eq!(outcome["status"], "created");
    let (total, available) = env.storage(&env.attestations, alice.id()).await?.expect("registered");
    // attest_ok attaches 0.1 NEAR, credited first.
    assert_eq!(total, near(1).as_yoctonear() + millinear(100).as_yoctonear());
    let locked = total - available;
    assert!(locked > MIN_STORAGE);

    // Withdraw needs exactly 1 yoctoNEAR and at most the available balance.
    fails_with(withdraw(&env, alice, Some(1), 0).await?, "Requires attached deposit of exactly 1 yoctoNEAR");
    fails_with(
        withdraw(&env, alice, Some(available + 1), 1).await?,
        "amount exceeds the available storage balance",
    );
    let before = env.balance(alice).await?;
    let half = millinear(500).as_yoctonear();
    let withdrawn = ok(withdraw(&env, alice, Some(half), 1).await?);
    let spent = burnt(&withdrawn);
    let after: Value = withdrawn.json()?;
    assert_eq!(u128_of(&after["available"]), available - half);
    assert_eq!(env.balance(alice).await?, before + half - spent - 1);

    // Everything available out, then the next attestation finds the balance too low.
    let _ = ok(withdraw(&env, alice, None, 1).await?);
    assert_eq!(env.storage(&env.attestations, alice.id()).await?, Some((locked, 0)));
    let low = env.attest(alice, &schema, "bob.test.near", b"again", None, yocto(0)).await?;
    fails_with(low, "storage balance too low");

    // Unregistering is refused while the account pays for attestations, and force is refused.
    fails_with(unregister(&env, alice, false).await?, "the account still pays for stored data");
    fails_with(unregister(&env, alice, true).await?, "force is not supported");

    // An account that only registered gets everything back.
    let start = env.balance(dave).await?;
    let deposit = ok(dave
        .call(env.attestations.id(), "storage_deposit")
        .args_json(json!({ "account_id": null, "registration_only": null }))
        .deposit(millinear(100))
        .transact()
        .await?);
    let gone = ok(unregister(&env, dave, false).await?);
    assert!(gone.clone().json::<bool>()?);
    assert_eq!(env.storage(&env.attestations, dave.id()).await?, None);
    assert_eq!(env.balance(dave).await?, start - burnt(&deposit) - burnt(&gone) - 1);
    assert!(!ok(unregister(&env, dave, false).await?).json::<bool>()?);
    Ok(())
}

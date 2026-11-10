//! Each resolver kind on its own, then pipelines that abort a charged fee.

use attestra_sandbox_tests::crypto::{attestation_uid, b64};
use attestra_sandbox_tests::util::{event, events, millinear, ok, tokens, u128_of, yocto, TOKEN, TX_GAS};
use attestra_sandbox_tests::Env;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

/// Calls an admin setter on a resolver with 0.05 NEAR for its storage; returns what it returned.
async fn admin(who: &Account, resolver: &AccountId, method: &str, args: Value) -> anyhow::Result<Value> {
    let result =
        ok(who.call(resolver, method).args_json(args).deposit(millinear(50)).gas(TX_GAS).transact().await?);
    let bytes = result.raw_bytes()?;
    Ok(if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes)? })
}

/// Attests with no deposit (the attester holds a storage balance) and returns the outcome.
async fn attest(
    env: &Env,
    who: &Account,
    schema: &str,
    subject: &str,
    data: &[u8],
) -> anyhow::Result<(Value, ExecutionFinalResult)> {
    let result = ok(env.attest(who, schema, subject, data, None, yocto(0)).await?);
    Ok((result.clone().json()?, result))
}

/// Checks an attestation the resolver refused: removed, logged and reported as rejected.
async fn assert_rejected(env: &Env, outcome: &Value, result: &ExecutionFinalResult) -> anyhow::Result<()> {
    assert_eq!(outcome["status"], "rejected", "logs: {:#?}", result.logs());
    let uid = outcome["uid"].as_str().expect("uid");
    assert_eq!(event(result, "attestation_rejected")["uid"], uid);
    assert!(events(result, "attestation_created").is_empty());
    assert!(env.attestation(uid).await?.is_none());
    Ok(())
}

async fn deposit_storage(env: &Env, who: &Account) -> anyhow::Result<()> {
    let _ = ok(who
        .call(env.attestations.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(millinear(500))
        .transact()
        .await?);
    Ok(())
}

async fn fee_balance(env: &Env, who: &AccountId, token: Option<&AccountId>) -> anyhow::Result<u128> {
    let b: Value = env.view(&env.fee, "balance_of", json!({ "account_id": who, "token": token })).await?;
    Ok(u128_of(&b))
}

async fn collected(env: &Env, schema: &str, token: Option<&AccountId>) -> anyhow::Result<u128> {
    let c: Value = env.view(&env.fee, "collected", json!({ "schema_uid": schema, "token": token })).await?;
    Ok(u128_of(&c))
}

#[tokio::test]
async fn whitelist_resolver() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, bob, carol) = (&env.alice, &env.bob, &env.carol);
    let schema = env.schema(alice, "string name", Some(env.whitelist.id()), true).await?;
    admin(
        alice,
        env.whitelist.id(),
        "whitelist_add",
        json!({ "schema_uid": schema, "account_id": bob.id() }),
    )
    .await?;
    assert!(
        env.view::<bool>(
            &env.whitelist,
            "is_whitelisted",
            json!({ "schema_uid": schema, "account_id": bob.id() })
        )
        .await?
    );
    let not_admin = bob
        .call(env.whitelist.id(), "whitelist_add")
        .args_json(json!({ "schema_uid": schema, "account_id": bob.id() }))
        .deposit(millinear(50))
        .transact()
        .await?;
    attestra_sandbox_tests::util::fails_with(not_admin, "only the schema admin");

    // Whitelisted: pending, then created.
    deposit_storage(&env, bob).await?;
    let (outcome, result) = attest(&env, bob, &schema, carol.id().as_str(), b"\x01\x00\x00\x00b").await?;
    assert_eq!(outcome["status"], "created");
    assert_eq!(event(&result, "attestation_pending")["uid"], outcome["uid"]);
    assert_eq!(event(&result, "attestation_created")["uid"], outcome["uid"]);
    let a = env.attestation(outcome["uid"].as_str().expect("uid")).await?.expect("stored");
    assert_eq!(a["status"], "active");

    // Not whitelisted: removed and the storage it took is back in carol's available balance.
    deposit_storage(&env, carol).await?;
    let plain = env.schema(carol, "string plain", None, true).await?;
    let _ = attest(&env, carol, &plain, bob.id().as_str(), b"first").await?;
    let before = env.storage(&env.attestations, carol.id()).await?.expect("registered");
    let count = env.attestation_count().await?;
    let (outcome, result) = attest(&env, carol, &schema, bob.id().as_str(), b"\x01\x00\x00\x00c").await?;
    assert_eq!(
        outcome["uid"],
        attestation_uid(&schema, bob.id().as_str(), carol.id().as_str(), b"\x01\x00\x00\x00c", 1)
    );
    assert_rejected(&env, &outcome, &result).await?;
    assert!(result.logs().iter().any(|l| l.contains("is not whitelisted")));
    assert_eq!(env.storage(&env.attestations, carol.id()).await?, Some(before));
    assert_eq!(env.attestation_count().await?, count);
    Ok(())
}

#[tokio::test]
async fn fee_resolver() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (bob, carol, dave) = (&env.bob, &env.carol, &env.dave);
    let token = env.token.id();
    let near_schema = env.schema(dave, "string paid_in_near", Some(env.fee.id()), true).await?;
    let ft_schema = env.schema(dave, "string paid_in_tatt", Some(env.fee.id()), true).await?;
    let fee = millinear(50).as_yoctonear();
    admin(
        dave,
        env.fee.id(),
        "set_fee",
        json!({ "schema_uid": near_schema, "token": null, "amount": fee.to_string() }),
    )
    .await?;
    admin(
        dave,
        env.fee.id(),
        "set_fee",
        json!({ "schema_uid": ft_schema, "token": token, "amount": tokens(20) }),
    )
    .await?;
    let view: Value = env.view(&env.fee, "get_fee", json!({ "schema_uid": ft_schema })).await?;
    assert_eq!(view, json!({ "token": token, "amount": tokens(20) }));
    for who in [bob, carol] {
        deposit_storage(&env, who).await?;
    }

    // NEAR prepaid with `deposit`.
    let deposited = ok(bob.call(env.fee.id(), "deposit").deposit(millinear(120)).transact().await?);
    assert_eq!(u128_of(&deposited.clone().json::<Value>()?), millinear(120).as_yoctonear());
    assert_eq!(u128_of(&event(&deposited, "fee_deposited")["amount"]), millinear(120).as_yoctonear());
    let (outcome, result) = attest(&env, bob, &near_schema, carol.id().as_str(), b"n1").await?;
    assert_eq!(outcome["status"], "created");
    let charged = event(&result, "fee_charged");
    assert_eq!(charged["attestation_uid"], outcome["uid"]);
    assert_eq!(charged["payer"], bob.id().as_str());
    assert_eq!(u128_of(&charged["amount"]), fee);
    assert_eq!(fee_balance(&env, bob.id(), None).await?, millinear(70).as_yoctonear());
    // Collected once the attestation is committed.
    assert_eq!(collected(&env, &near_schema, None).await?, fee);
    let _ = attest(&env, bob, &near_schema, carol.id().as_str(), b"n2").await?;
    assert_eq!(fee_balance(&env, bob.id(), None).await?, millinear(20).as_yoctonear());
    // 0.02 NEAR left is below the fee.
    let (outcome, result) = attest(&env, bob, &near_schema, carol.id().as_str(), b"n3").await?;
    assert_rejected(&env, &outcome, &result).await?;
    assert!(events(&result, "fee_charged").is_empty());
    assert_eq!(fee_balance(&env, bob.id(), None).await?, millinear(20).as_yoctonear());
    assert_eq!(collected(&env, &near_schema, None).await?, 2 * fee);
    // No prepaid balance at all.
    let (outcome, result) = attest(&env, carol, &near_schema, bob.id().as_str(), b"c1").await?;
    assert_rejected(&env, &outcome, &result).await?;

    // An NEP-141 token prepaid with `ft_transfer_call`.
    env.faucet(bob).await?;
    let sent = ok(env.ft_transfer_call(bob, env.fee.id(), 50 * TOKEN, "deposit").await?);
    assert_eq!(u128_of(&sent.json::<Value>()?), 50 * TOKEN);
    assert_eq!(fee_balance(&env, bob.id(), Some(token)).await?, 50 * TOKEN);
    assert_eq!(env.ft_balance(env.fee.id()).await?, 50 * TOKEN);
    // An unknown message returns the tokens.
    let returned = ok(env.ft_transfer_call(bob, env.fee.id(), 5 * TOKEN, "tip").await?);
    assert_eq!(u128_of(&returned.json::<Value>()?), 0);
    assert_eq!(env.ft_balance(bob.id()).await?, 950 * TOKEN);
    for data in [b"t1", b"t2"] {
        let (outcome, result) = attest(&env, bob, &ft_schema, carol.id().as_str(), data).await?;
        assert_eq!(outcome["status"], "created");
        assert_eq!(event(&result, "fee_charged")["token"], token.as_str());
    }
    assert_eq!(fee_balance(&env, bob.id(), Some(token)).await?, 10 * TOKEN);
    assert_eq!(collected(&env, &ft_schema, Some(token)).await?, 40 * TOKEN);
    let (outcome, result) = attest(&env, bob, &ft_schema, carol.id().as_str(), b"t3").await?;
    assert_rejected(&env, &outcome, &result).await?;
    assert_eq!(fee_balance(&env, bob.id(), Some(token)).await?, 10 * TOKEN);

    // The admin takes the collected fees; the payer takes back what is left.
    env.faucet(dave).await?;
    let claimed = ok(dave
        .call(env.fee.id(), "withdraw_fees")
        .args_json(json!({ "schema_uid": ft_schema, "token": token }))
        .gas(TX_GAS)
        .transact()
        .await?);
    assert_eq!(u128_of(&claimed.clone().json::<Value>()?), 40 * TOKEN);
    assert_eq!(u128_of(&event(&claimed, "fees_claimed")["amount"]), 40 * TOKEN);
    assert_eq!(env.ft_balance(dave.id()).await?, 1_040 * TOKEN);
    assert_eq!(collected(&env, &ft_schema, Some(token)).await?, 0);
    let before = env.balance(bob).await?;
    let withdrawn = ok(bob
        .call(env.fee.id(), "withdraw_balance")
        .args_json(json!({ "token": null, "amount": null }))
        .gas(near_workspaces::types::Gas::from_tgas(50))
        .transact()
        .await?);
    let burnt: u128 = withdrawn.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear()).sum();
    assert_eq!(u128_of(&withdrawn.json::<Value>()?), millinear(20).as_yoctonear());
    assert_eq!(fee_balance(&env, bob.id(), None).await?, 0);
    // Bob got the 0.02 NEAR back, less what the call burnt in gas.
    let gained = env.balance(bob).await? - before;
    assert_eq!(gained + burnt, millinear(20).as_yoctonear(), "gained {gained}, burnt {burnt}");
    Ok(())
}

#[tokio::test]
async fn token_gated_and_reward_resolvers() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (bob, carol, dave, eve) = (&env.bob, &env.carol, &env.dave, &env.eve);
    let token = env.token.id();
    for who in [bob, carol] {
        deposit_storage(&env, who).await?;
    }

    // Token gated: at least 500 tATT.
    let gated = env.schema(eve, "string holder", Some(env.gated.id()), true).await?;
    admin(
        eve,
        env.gated.id(),
        "set_gate",
        json!({ "schema_uid": gated, "token": token, "min_balance": tokens(500) }),
    )
    .await?;
    env.faucet(bob).await?;
    let (outcome, _) = attest(&env, bob, &gated, dave.id().as_str(), b"g1").await?;
    assert_eq!(outcome["status"], "created");
    let (outcome, result) = attest(&env, carol, &gated, dave.id().as_str(), b"g2").await?;
    assert_rejected(&env, &outcome, &result).await?;
    assert!(result.logs().iter().any(|l| l.contains("is below the minimum")));

    // Token reward: the subject is paid from the pool, registered on the token on the way.
    let rewarded = env.schema(eve, "string contributor", Some(env.reward.id()), true).await?;
    admin(
        eve,
        env.reward.id(),
        "set_reward",
        json!({ "schema_uid": rewarded, "token": token, "amount": tokens(10) }),
    )
    .await?;
    env.faucet(eve).await?;
    let funded = ok(env
        .ft_transfer_call(eve, env.reward.id(), 100 * TOKEN, &json!({ "fund": rewarded }).to_string())
        .await?);
    assert_eq!(u128_of(&event(&funded, "reward_funded")["pool"]), 100 * TOKEN);
    assert_eq!(env.ft_balance(dave.id()).await?, 0);
    let storage: Option<Value> =
        env.view(&env.token, "storage_balance_of", json!({ "account_id": dave.id() })).await?;
    assert!(storage.is_none());

    let (outcome, result) = attest(&env, bob, &rewarded, dave.id().as_str(), b"r1").await?;
    assert_eq!(outcome["status"], "created");
    let paid = event(&result, "reward_paid");
    assert_eq!(paid["account_id"], dave.id().as_str());
    assert_eq!(u128_of(&paid["amount"]), 10 * TOKEN);
    assert_eq!(env.ft_balance(dave.id()).await?, 10 * TOKEN);
    let distributed: Value = env
        .view(&env.reward, "distributed", json!({ "schema_uid": rewarded, "account_id": dave.id() }))
        .await?;
    assert_eq!(u128_of(&distributed), 10 * TOKEN);
    let reward: Value = env.view(&env.reward, "get_reward", json!({ "schema_uid": rewarded })).await?;
    assert_eq!(u128_of(&reward["pool"]), 90 * TOKEN);
    assert_eq!(u128_of(&reward["distributed_total"]), 10 * TOKEN);

    // A second reward to the same, now registered, subject.
    let _ = attest(&env, carol, &rewarded, dave.id().as_str(), b"r2").await?;
    assert_eq!(env.ft_balance(dave.id()).await?, 20 * TOKEN);
    // A CAIP-10 subject gets no reward and the pool is untouched.
    let (outcome, result) =
        attest(&env, bob, &rewarded, "eip155:1:0xab5801a7d398351b8be11c439e05c5b3259aec9b", b"r3").await?;
    assert_eq!(outcome["status"], "created");
    assert!(events(&result, "reward_paid").is_empty());
    let reward: Value = env.view(&env.reward, "get_reward", json!({ "schema_uid": rewarded })).await?;
    assert_eq!(u128_of(&reward["pool"]), 80 * TOKEN);
    Ok(())
}

#[tokio::test]
async fn pipelines_abort_charged_fees() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, bob, carol, dave) = (&env.alice, &env.bob, &env.carol, &env.dave);
    let fee = millinear(50).as_yoctonear();
    for who in [bob, carol, dave] {
        deposit_storage(&env, who).await?;
    }

    // Whitelist, then fee.
    let first = env.schema(alice, "string whitelist_then_fee", Some(env.pipeline.id()), true).await?;
    let set = admin(
        alice,
        env.pipeline.id(),
        "set_pipeline",
        json!({ "schema_uid": first, "resolvers": [env.whitelist.id(), env.fee.id()] }),
    )
    .await?;
    assert_eq!(set, json!(true));
    let listed: Vec<AccountId> =
        env.view(&env.pipeline, "get_pipeline", json!({ "schema_uid": first })).await?;
    assert_eq!(listed, vec![env.whitelist.id().clone(), env.fee.id().clone()]);
    for resolver in [&env.whitelist, &env.fee] {
        let admin_of: Option<AccountId> =
            env.view(resolver, "schema_admin", json!({ "schema_uid": first })).await?;
        assert_eq!(admin_of.as_ref(), Some(alice.id()));
    }
    for who in [bob, carol] {
        admin(
            alice,
            env.whitelist.id(),
            "whitelist_add",
            json!({ "schema_uid": first, "account_id": who.id() }),
        )
        .await?;
    }
    admin(
        alice,
        env.fee.id(),
        "set_fee",
        json!({ "schema_uid": first, "token": null, "amount": fee.to_string() }),
    )
    .await?;
    let _ = ok(bob.call(env.fee.id(), "deposit").deposit(millinear(200)).transact().await?);
    let _ = ok(dave.call(env.fee.id(), "deposit").deposit(millinear(200)).transact().await?);

    let (outcome, result) = attest(&env, bob, &first, alice.id().as_str(), b"ok").await?;
    assert_eq!(outcome["status"], "created");
    assert_eq!(event(&result, "fee_charged")["payer"], bob.id().as_str());
    assert_eq!(collected(&env, &first, None).await?, fee);
    // Carol passes the whitelist but has no prepaid fee: the fee step refuses, nothing to undo.
    let (outcome, result) = attest(&env, carol, &first, alice.id().as_str(), b"no fee").await?;
    assert_rejected(&env, &outcome, &result).await?;
    assert!(events(&result, "fee_charged").is_empty());
    assert!(events(&result, "fee_refunded").is_empty());
    assert_eq!(collected(&env, &first, None).await?, fee);

    // Fee, then whitelist: dave pays, the whitelist refuses, and the fee comes back.
    let second = env.schema(alice, "string fee_then_whitelist", Some(env.pipeline.id()), true).await?;
    admin(
        alice,
        env.pipeline.id(),
        "set_pipeline",
        json!({ "schema_uid": second, "resolvers": [env.fee.id(), env.whitelist.id()] }),
    )
    .await?;
    admin(
        alice,
        env.whitelist.id(),
        "whitelist_add",
        json!({ "schema_uid": second, "account_id": bob.id() }),
    )
    .await?;
    admin(
        alice,
        env.fee.id(),
        "set_fee",
        json!({ "schema_uid": second, "token": null, "amount": fee.to_string() }),
    )
    .await?;

    let (outcome, result) = attest(&env, dave, &second, alice.id().as_str(), b"refund me").await?;
    assert_rejected(&env, &outcome, &result).await?;
    let charged = event(&result, "fee_charged");
    let refunded = event(&result, "fee_refunded");
    assert_eq!(charged["attestation_uid"], outcome["uid"]);
    assert_eq!(refunded["attestation_uid"], outcome["uid"]);
    assert_eq!(refunded["payer"], dave.id().as_str());
    assert_eq!(u128_of(&refunded["amount"]), fee);
    assert_eq!(fee_balance(&env, dave.id(), None).await?, millinear(200).as_yoctonear());
    assert_eq!(collected(&env, &second, None).await?, 0);

    let (outcome, _) = attest(&env, bob, &second, alice.id().as_str(), b"paid").await?;
    assert_eq!(outcome["status"], "created");
    assert_eq!(collected(&env, &second, None).await?, fee);
    assert_eq!(fee_balance(&env, bob.id(), None).await?, millinear(100).as_yoctonear());
    Ok(())
}

/// The setup the reward resolver recommends: a whitelist in front of it, and every kind at once.
#[tokio::test]
async fn pipelines_with_rewards() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let (alice, bob, carol, eve) = (&env.alice, &env.bob, &env.carol, &env.eve);
    let token = env.token.id();
    for who in [bob, carol] {
        deposit_storage(&env, who).await?;
    }
    env.faucet(alice).await?;
    env.faucet(bob).await?;

    // Whitelist, then reward.
    let members = env.schema(alice, "string member", Some(env.pipeline.id()), true).await?;
    let set = admin(
        alice,
        env.pipeline.id(),
        "set_pipeline",
        json!({ "schema_uid": members, "resolvers": [env.whitelist.id(), env.reward.id()] }),
    )
    .await?;
    assert_eq!(set, json!(true));
    admin(
        alice,
        env.whitelist.id(),
        "whitelist_add",
        json!({ "schema_uid": members, "account_id": bob.id() }),
    )
    .await?;
    admin(
        alice,
        env.reward.id(),
        "set_reward",
        json!({ "schema_uid": members, "token": token, "amount": tokens(10) }),
    )
    .await?;
    let _ = ok(env
        .ft_transfer_call(alice, env.reward.id(), 100 * TOKEN, &json!({ "fund": members }).to_string())
        .await?);

    let (outcome, result) = attest(&env, bob, &members, eve.id().as_str(), b"m1").await?;
    assert_eq!(outcome["status"], "created");
    assert_eq!(event(&result, "reward_paid")["account_id"], eve.id().as_str());
    assert_eq!(env.ft_balance(eve.id()).await?, 10 * TOKEN);
    let (outcome, result) = attest(&env, carol, &members, eve.id().as_str(), b"m2").await?;
    assert_rejected(&env, &outcome, &result).await?;
    assert!(events(&result, "reward_paid").is_empty());
    assert_eq!(env.ft_balance(eve.id()).await?, 10 * TOKEN);

    // Four resolvers: whitelist, token gated, fee and reward.
    let full = env.schema(alice, "string full_pipeline", Some(env.pipeline.id()), true).await?;
    let resolvers = [env.whitelist.id(), env.gated.id(), env.fee.id(), env.reward.id()];
    let set = admin(
        alice,
        env.pipeline.id(),
        "set_pipeline",
        json!({ "schema_uid": full, "resolvers": resolvers }),
    )
    .await?;
    assert_eq!(set, json!(true));
    admin(alice, env.whitelist.id(), "whitelist_add", json!({ "schema_uid": full, "account_id": bob.id() }))
        .await?;
    admin(
        alice,
        env.gated.id(),
        "set_gate",
        json!({ "schema_uid": full, "token": token, "min_balance": tokens(100) }),
    )
    .await?;
    let fee = millinear(10).as_yoctonear();
    admin(
        alice,
        env.fee.id(),
        "set_fee",
        json!({ "schema_uid": full, "token": null, "amount": fee.to_string() }),
    )
    .await?;
    admin(
        alice,
        env.reward.id(),
        "set_reward",
        json!({ "schema_uid": full, "token": token, "amount": tokens(5) }),
    )
    .await?;
    let _ = ok(env
        .ft_transfer_call(alice, env.reward.id(), 50 * TOKEN, &json!({ "fund": full }).to_string())
        .await?);
    let _ = ok(bob.call(env.fee.id(), "deposit").deposit(millinear(100)).transact().await?);

    // The payout runs in on_committed, forwarded by the pipeline to all four resolvers; with this
    // many hooks it needs more than 300 TGas, so the caller attaches up to 1 PGas.
    let result = ok(bob
        .call(env.attestations.id(), "attest")
        .args_json(json!({ "schema_uid": full, "subject": eve.id(), "data": b64(b"f1"), "expiration_time": null, "ref_uid": null }))
        .max_gas()
        .transact()
        .await?);
    let outcome: Value = result.clone().json()?;
    assert_eq!(outcome["status"], "created", "logs: {:#?}", result.logs());
    assert_eq!(event(&result, "fee_charged")["payer"], bob.id().as_str());
    assert_eq!(event(&result, "reward_paid")["account_id"], eve.id().as_str());
    assert_eq!(collected(&env, &full, None).await?, fee);
    assert_eq!(env.ft_balance(eve.id()).await?, 15 * TOKEN);
    Ok(())
}

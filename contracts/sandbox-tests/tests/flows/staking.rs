//! Staking tATT for authority tiers pushed to the attestations contract.

use attestra_sandbox_tests::util::{
    event, fails_with, millinear, nep297, ok, tokens, u128_of, yocto, TOKEN, TX_GAS,
};
use attestra_sandbox_tests::Env;
use serde_json::{json, Value};

#[tokio::test]
async fn staking_tiers() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let bob = &env.bob;
    let _ = ok(bob
        .call(env.attestations.id(), "register_authority")
        .args_json(json!({ "metadata": "Bob Org", "kind": null }))
        .deposit(millinear(100))
        .transact()
        .await?);
    env.faucet(bob).await?;
    // The faucet is hourly.
    fails_with(bob.call(env.token.id(), "faucet").transact().await?, "the faucet can be used once an hour");
    let minted = ok(env
        .owner
        .call(env.token.id(), "mint")
        .args_json(json!({ "account_id": bob.id(), "amount": tokens(1_000) }))
        .transact()
        .await?);
    assert_eq!(nep297(&minted, "nep141", "ft_mint").len(), 1);
    assert_eq!(env.ft_balance(bob.id()).await?, 2_000 * TOKEN);

    // 150 tATT reaches Bronze; the tier lands in the attestations contract in the same transaction.
    let staked = ok(env.ft_transfer_call(bob, env.staking.id(), 150 * TOKEN, "stake").await?);
    let changed = event(&staked, "stake_changed");
    assert_eq!(changed["tier"], "Bronze");
    assert_eq!(u128_of(&changed["staked"]), 150 * TOKEN);
    let pushed = event(&staked, "authority_tier");
    assert_eq!(pushed["account_id"], bob.id().as_str());
    assert_eq!(pushed["tier"], "Bronze");
    let stake: Value = env.view(&env.staking, "get_stake", json!({ "account_id": bob.id() })).await?;
    assert_eq!(stake, json!({ "staked": tokens(150), "tier": "Bronze" }));
    let tier: Value = env.view(&env.attestations, "get_tier", json!({ "account_id": bob.id() })).await?;
    assert_eq!(tier, json!({ "tier": "Bronze", "staked": tokens(150) }));
    let authority: Value =
        env.view(&env.attestations, "get_authority", json!({ "account_id": bob.id() })).await?;
    assert_eq!(authority["tier"], "Bronze");
    assert_eq!(authority["staked"], tokens(150));

    // 900 more with an empty message: Silver.
    let _ = ok(env.ft_transfer_call(bob, env.staking.id(), 900 * TOKEN, "").await?);
    let authority: Value =
        env.view(&env.attestations, "get_authority", json!({ "account_id": bob.id() })).await?;
    assert_eq!(authority["tier"], "Silver");
    assert_eq!(authority["staked"], tokens(1_050));
    // An unknown message sends the tokens back.
    let refused = ok(env.ft_transfer_call(bob, env.staking.id(), 10 * TOKEN, "hold").await?);
    assert_eq!(u128_of(&refused.json::<Value>()?), 0);
    assert_eq!(env.ft_balance(bob.id()).await?, 950 * TOKEN);
    let total: Value = env.view(&env.staking, "total_staked", json!({})).await?;
    assert_eq!(total, json!(tokens(1_050)));

    // Unstaking needs 1 yoctoNEAR and lowers the tier.
    let unstake = |amount: u128, deposit: u128| {
        bob.call(env.staking.id(), "unstake")
            .args_json(json!({ "amount": amount.to_string() }))
            .deposit(yocto(deposit))
            .gas(TX_GAS)
            .transact()
    };
    fails_with(unstake(10 * TOKEN, 0).await?, "Requires attached deposit of exactly 1 yoctoNEAR");
    fails_with(unstake(2_000 * TOKEN, 1).await?, "amount exceeds the stake");
    let unstaked = ok(unstake(1_000 * TOKEN, 1).await?);
    assert_eq!(u128_of(&unstaked.clone().json::<Value>()?), 1_000 * TOKEN);
    assert_eq!(event(&unstaked, "authority_tier")["tier"], Value::Null);
    assert_eq!(env.ft_balance(bob.id()).await?, 1_950 * TOKEN);
    let tier: Value = env.view(&env.attestations, "get_tier", json!({ "account_id": bob.id() })).await?;
    assert_eq!(tier, json!({ "tier": null, "staked": tokens(50) }));
    let authority: Value =
        env.view(&env.attestations, "get_authority", json!({ "account_id": bob.id() })).await?;
    assert_eq!(authority["tier"], Value::Null);
    // Unstaking the rest leaves no tier entry behind; the view reads the default.
    let _ = ok(unstake(50 * TOKEN, 1).await?);
    let tier: Value = env.view(&env.attestations, "get_tier", json!({ "account_id": bob.id() })).await?;
    assert_eq!(tier, json!({ "tier": null, "staked": "0" }));
    assert_eq!(env.ft_balance(bob.id()).await?, 2_000 * TOKEN);

    // Only the token can stake and only staking can push tiers.
    let fake = bob
        .call(env.staking.id(), "ft_on_transfer")
        .args_json(json!({ "sender_id": bob.id(), "amount": tokens(1_000_000), "msg": "stake" }))
        .transact()
        .await?;
    fails_with(fake, "only the staking token can be staked");
    let forged = bob
        .call(env.attestations.id(), "on_tier_changed")
        .args_json(json!({ "account_id": bob.id(), "tier": "Gold", "staked": tokens(1) }))
        .transact()
        .await?;
    fails_with(forged, "only the staking contract");
    Ok(())
}

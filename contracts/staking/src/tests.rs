use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn token() -> AccountId {
    acc("token.testnet")
}
fn attestations() -> AccountId {
    acc("attestations.testnet")
}
fn me() -> AccountId {
    acc("staking.testnet")
}
fn alice() -> AccountId {
    acc("alice.testnet")
}
fn bob() -> AccountId {
    acc("bob.testnet")
}

fn context(predecessor: &AccountId, deposit: u128) -> near_sdk::VMContext {
    VMContextBuilder::new()
        .current_account_id(me())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build()
}

fn ctx(predecessor: &AccountId, deposit: u128) {
    testing_env!(context(predecessor, deposit));
}

fn callback(results: Vec<PromiseResult>) {
    testing_env!(context(&me(), 0), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

fn tier(name: &str, min: u128) -> Tier {
    Tier { name: name.to_string(), min: U128(min) }
}

fn small_tiers() -> Vec<Tier> {
    vec![tier("Bronze", 100), tier("Silver", 1_000), tier("Gold", 10_000)]
}

fn setup() -> Contract {
    ctx(&owner(), 0);
    Contract::new(owner(), token(), attestations(), small_tiers())
}

fn stake(c: &mut Contract, account: &AccountId, amount: u128) -> U128 {
    ctx(&token(), 0);
    c.ft_on_transfer(account.clone(), U128(amount), "stake".to_string())
}

#[derive(Debug)]
struct Call {
    receiver: AccountId,
    method: String,
    args: Value,
    deposit: u128,
    gas: Gas,
}

fn calls() -> Vec<Call> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::FunctionCallWeight {
                method_name, args, attached_deposit, prepaid_gas, ..
            } = action
            {
                out.push(Call {
                    receiver: receipt.receiver_id.clone(),
                    method: String::from_utf8(method_name).unwrap(),
                    args: serde_json::from_slice(&args).unwrap(),
                    deposit: attached_deposit.as_yoctonear(),
                    gas: prepaid_gas,
                });
            }
        }
    }
    out
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn init_with_tiers() {
    let c = setup();
    assert_eq!(c.get_tiers(), small_tiers());
    assert_eq!(c.total_staked(), U128(0));
    assert_eq!(c.get_stake(alice()), StakeView { staked: U128(0), tier: None });
    let json = serde_json::to_value(c.get_tiers()).unwrap();
    assert_eq!(json[0], serde_json::json!({ "name": "Bronze", "min": "100" }));
}

#[test]
fn init_defaults_to_bronze_silver_gold() {
    ctx(&owner(), 0);
    let c = Contract::new(owner(), token(), attestations(), vec![]);
    let whole = 10u128.pow(18);
    assert_eq!(
        c.get_tiers(),
        vec![tier("Bronze", 100 * whole), tier("Silver", 1_000 * whole), tier("Gold", 10_000 * whole)]
    );
    assert_eq!(c.get_tiers(), default_tiers());
}

macro_rules! bad_tiers {
    ($name:ident, $tiers:expr, $expected:literal) => {
        #[test]
        #[should_panic(expected = $expected)]
        fn $name() {
            ctx(&owner(), 0);
            Contract::new(owner(), token(), attestations(), $tiers);
        }
    };
}

bad_tiers!(tiers_must_be_sorted, vec![tier("Silver", 1_000), tier("Bronze", 100)], "sorted ascending");
bad_tiers!(tiers_must_not_tie, vec![tier("A", 100), tier("B", 100)], "sorted ascending");
bad_tiers!(tier_minimums_must_be_positive, vec![tier("Zero", 0)], "must be positive");
bad_tiers!(tier_names_must_be_distinct, vec![tier("A", 1), tier("A", 2)], "names must be distinct");
bad_tiers!(tier_names_must_not_be_empty, vec![tier("", 1)], "tier names have 1 to 32 bytes");
bad_tiers!(tier_names_are_bounded, vec![tier(&"x".repeat(33), 1)], "tier names have 1 to 32 bytes");
bad_tiers!(tiers_are_bounded, (1..=17).map(|i| tier(&format!("T{i}"), i)).collect(), "at most 16 tiers");

#[test]
fn stake_through_ft_transfer_call() {
    let mut c = setup();
    assert_eq!(stake(&mut c, &alice(), 150), U128(0));
    assert_eq!(c.get_stake(alice()), StakeView { staked: U128(150), tier: Some("Bronze".into()) });
    assert_eq!(c.total_staked(), U128(150));

    let e = events();
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event"], "stake_changed");
    assert_eq!(
        e[0]["data"][0],
        serde_json::json!({
            "account_id": "alice.testnet", "action": "stake", "amount": "150", "staked": "150",
            "tier": "Bronze", "total_staked": "150",
        })
    );

    let cs = calls();
    assert_eq!(cs.len(), 1);
    assert_eq!(cs[0].receiver, attestations());
    assert_eq!(cs[0].method, "on_tier_changed");
    assert_eq!(
        cs[0].args,
        serde_json::json!({ "account_id": "alice.testnet", "tier": "Bronze", "staked": "150" })
    );
    assert_eq!(cs[0].deposit, 0);
    assert_eq!(cs[0].gas, Gas::from_tgas(10));

    // The empty message stakes too.
    ctx(&token(), 0);
    assert_eq!(c.ft_on_transfer(alice(), U128(850), String::new()), U128(0));
    assert_eq!(c.get_stake(alice()).tier.as_deref(), Some("Silver"));
    assert_eq!(c.total_staked(), U128(1_000));
}

#[test]
fn unknown_messages_return_the_tokens() {
    let mut c = setup();
    ctx(&token(), 0);
    assert_eq!(c.ft_on_transfer(alice(), U128(150), "deposit".to_string()), U128(150));
    assert_eq!(c.get_stake(alice()).staked, U128(0));
    assert!(events().is_empty());
    assert!(calls().is_empty());
}

#[test]
fn zero_transfers_change_nothing() {
    let mut c = setup();
    assert_eq!(stake(&mut c, &alice(), 0), U128(0));
    assert!(events().is_empty());
    assert!(calls().is_empty());
}

#[test]
#[should_panic(expected = "only the staking token can be staked")]
fn other_tokens_are_refused() {
    let mut c = setup();
    ctx(&acc("other-token.testnet"), 0);
    c.ft_on_transfer(alice(), U128(150), String::new());
}

#[test]
fn tiers_follow_the_thresholds() {
    let mut c = setup();
    let cases = [
        (99, None),
        (1, Some("Bronze")),
        (899, Some("Bronze")),
        (1, Some("Silver")),
        (8_999, Some("Silver")),
        (1, Some("Gold")),
        (1_000_000, Some("Gold")),
    ];
    for (add, expected) in cases {
        stake(&mut c, &alice(), add);
        assert_eq!(c.get_stake(alice()).tier.as_deref(), expected);
        assert_eq!(calls()[0].args["tier"], serde_json::json!(expected));
    }
}

#[test]
fn stakes_are_per_account() {
    let mut c = setup();
    stake(&mut c, &alice(), 100);
    stake(&mut c, &bob(), 20_000);
    assert_eq!(c.get_stake(alice()).tier.as_deref(), Some("Bronze"));
    assert_eq!(c.get_stake(bob()).tier.as_deref(), Some("Gold"));
    assert_eq!(c.total_staked(), U128(20_100));
}

#[test]
fn unstake_sends_tokens_and_pushes_the_tier() {
    let mut c = setup();
    stake(&mut c, &alice(), 1_200);
    ctx(&alice(), 1);
    let _ = c.unstake(U128(300));
    assert_eq!(c.get_stake(alice()), StakeView { staked: U128(900), tier: Some("Bronze".into()) });
    assert_eq!(c.total_staked(), U128(900));

    let e = events();
    assert_eq!(e[0]["data"][0]["action"], "unstake");
    assert_eq!(e[0]["data"][0]["staked"], "900");
    assert_eq!(e[0]["data"][0]["tier"], "Bronze");

    let cs = calls();
    assert_eq!(cs.len(), 3);
    assert_eq!(cs[0].receiver, attestations());
    assert_eq!(cs[0].method, "on_tier_changed");
    assert_eq!(
        cs[0].args,
        serde_json::json!({ "account_id": "alice.testnet", "tier": "Bronze", "staked": "900" })
    );
    assert_eq!(cs[1].receiver, token());
    assert_eq!(cs[1].method, "ft_transfer");
    assert_eq!(cs[1].deposit, 1);
    assert_eq!(
        cs[1].args,
        serde_json::json!({ "receiver_id": "alice.testnet", "amount": "300", "memo": null })
    );
    assert_eq!(cs[2].receiver, me());
    assert_eq!(cs[2].method, "unstake_settled");
    assert_eq!(cs[2].args, serde_json::json!({ "account_id": "alice.testnet", "amount": "300" }));

    callback(vec![PromiseResult::Successful(vec![])]);
    assert_eq!(c.unstake_settled(alice(), U128(300)), U128(300));
    assert!(events().is_empty());
    assert!(calls().is_empty());
    assert_eq!(c.get_stake(alice()).staked, U128(900));
}

#[test]
fn failed_unstake_restores_the_stake() {
    let mut c = setup();
    stake(&mut c, &alice(), 1_000);
    ctx(&alice(), 1);
    let _ = c.unstake(U128(1_000));
    assert_eq!(c.get_stake(alice()), StakeView { staked: U128(0), tier: None });
    assert_eq!(c.total_staked(), U128(0));
    assert_eq!(calls()[0].args["tier"], Value::Null);

    callback(vec![PromiseResult::Failed]);
    assert_eq!(c.unstake_settled(alice(), U128(1_000)), U128(0));
    assert_eq!(c.get_stake(alice()), StakeView { staked: U128(1_000), tier: Some("Silver".into()) });
    assert_eq!(c.total_staked(), U128(1_000));
    let e = events();
    assert_eq!(e[0]["data"][0]["action"], "unstake_failed");
    assert_eq!(e[0]["data"][0]["tier"], "Silver");
    let cs = calls();
    assert_eq!(cs.len(), 1);
    assert_eq!(cs[0].method, "on_tier_changed");
    assert_eq!(cs[0].args["tier"], "Silver");
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn unstake_requires_one_yocto() {
    let mut c = setup();
    stake(&mut c, &alice(), 1_000);
    ctx(&alice(), 0);
    let _ = c.unstake(U128(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn unstake_rejects_more_than_one_yocto() {
    let mut c = setup();
    stake(&mut c, &alice(), 1_000);
    ctx(&alice(), 2);
    let _ = c.unstake(U128(1));
}

#[test]
#[should_panic(expected = "amount exceeds the stake")]
fn unstake_more_than_staked() {
    let mut c = setup();
    stake(&mut c, &alice(), 1_000);
    ctx(&alice(), 1);
    let _ = c.unstake(U128(1_001));
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn unstake_zero() {
    let mut c = setup();
    stake(&mut c, &alice(), 1_000);
    ctx(&alice(), 1);
    let _ = c.unstake(U128(0));
}

#[test]
#[should_panic(expected = "amount exceeds the stake")]
fn unstake_without_a_stake() {
    let mut c = setup();
    ctx(&bob(), 1);
    let _ = c.unstake(U128(1));
}

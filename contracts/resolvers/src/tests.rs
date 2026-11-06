use super::*;
use near_sdk::json_types::Base64VecU8;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{serde_json, test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const SCHEMA: Uid = Uid([1; 32]);
const OTHER_SCHEMA: Uid = Uid([2; 32]);
const ATTESTATION: Uid = Uid([9; 32]);

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn schemas() -> AccountId {
    acc("schemas.testnet")
}
fn attestations() -> AccountId {
    acc("attestations.testnet")
}
fn me() -> AccountId {
    acc("resolver.testnet")
}
fn admin() -> AccountId {
    acc("admin.testnet")
}
fn alice() -> AccountId {
    acc("alice.testnet")
}
fn bob() -> AccountId {
    acc("bob.testnet")
}
fn token() -> AccountId {
    acc("token.testnet")
}
fn pipeline_account() -> AccountId {
    acc("pipeline.testnet")
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

/// A callback context with the given promise results.
fn callback(results: Vec<PromiseResult>) {
    testing_env!(context(&me(), 0), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

fn ok_json<T: near_sdk::serde::Serialize>(value: &T) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(value).unwrap())
}

fn setup(kind: ResolverKind) -> Contract {
    ctx(&owner(), 0);
    let mut c = Contract::new(owner(), kind, schemas(), attestations());
    ctx(&schemas(), 0);
    assert!(c.on_schema_registered(SCHEMA, admin()));
    c
}

fn resolver_call(op: ResolverOp, attester: &AccountId, subject: &str) -> ResolverCall {
    ResolverCall {
        op,
        attestation_uid: ATTESTATION,
        schema_uid: SCHEMA,
        attester: attester.clone(),
        actor: attester.clone(),
        subject: subject.to_string(),
        data: Base64VecU8(vec![1, 2, 3]),
    }
}

fn attest(attester: &AccountId) -> ResolverCall {
    resolver_call(ResolverOp::Attest, attester, "bob.testnet")
}

fn value(result: PromiseOrValue<bool>) -> bool {
    match result {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("expected a value, got a promise"),
    }
}

#[derive(Debug)]
struct Call {
    receiver: AccountId,
    method: String,
    args: serde_json::Value,
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
                    args: serde_json::from_slice(&args).unwrap_or(serde_json::Value::Null),
                    deposit: attached_deposit.as_yoctonear(),
                    gas: prepaid_gas,
                });
            }
        }
    }
    out
}

fn receipt_index(receipt: &near_sdk::mock::Receipt) -> u64 {
    match &receipt.actions[0] {
        MockAction::FunctionCallWeight { receipt_index, .. } => *receipt_index,
        MockAction::Transfer { receipt_index, .. } => *receipt_index,
        other => panic!("unexpected action {other:?}"),
    }
}

fn transfers() -> Vec<(AccountId, u128)> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::Transfer { deposit, .. } = action {
                out.push((receipt.receiver_id.clone(), deposit.as_yoctonear()));
            }
        }
    }
    out
}

fn events() -> Vec<serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn event_names() -> Vec<String> {
    events().iter().map(|e| e["event"].as_str().unwrap().to_string()).collect()
}

// Common

#[test]
fn init_and_info() {
    let c = setup(ResolverKind::Whitelist);
    let info = c.resolver_info();
    assert_eq!(info.kind, ResolverKind::Whitelist);
    assert_eq!(info.owner, owner());
    assert_eq!(info.schemas, schemas());
    assert_eq!(info.attestations, attestations());
    assert!(info.trusted_pipelines.is_empty());
    assert_eq!(c.schema_admin(SCHEMA), Some(admin()));
    assert_eq!(c.schema_admin(OTHER_SCHEMA), None);
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["kind"], "whitelist");
}

#[test]
fn kind_json_is_snake_case() {
    for (kind, name) in [
        (ResolverKind::Whitelist, "whitelist"),
        (ResolverKind::Fee, "fee"),
        (ResolverKind::TokenGated, "token_gated"),
        (ResolverKind::TokenReward, "token_reward"),
        (ResolverKind::Pipeline, "pipeline"),
    ] {
        assert_eq!(serde_json::to_value(kind).unwrap(), name);
        assert_eq!(kind.as_str(), name);
    }
}

#[test]
fn trusted_pipelines_are_owner_managed() {
    let mut c = setup(ResolverKind::Whitelist);
    ctx(&owner(), 0);
    c.add_trusted_pipeline(pipeline_account());
    c.add_trusted_pipeline(pipeline_account());
    assert_eq!(c.resolver_info().trusted_pipelines, vec![pipeline_account()]);
    assert_eq!(event_names(), vec!["resolver_configured"]);
    c.remove_trusted_pipeline(pipeline_account());
    c.remove_trusted_pipeline(pipeline_account());
    assert!(c.resolver_info().trusted_pipelines.is_empty());
}

#[test]
#[should_panic(expected = "only the owner")]
fn trusted_pipeline_add_requires_owner() {
    let mut c = setup(ResolverKind::Whitelist);
    ctx(&alice(), 0);
    c.add_trusted_pipeline(pipeline_account());
}

#[test]
#[should_panic(expected = "only the owner")]
fn trusted_pipeline_remove_requires_owner() {
    let mut c = setup(ResolverKind::Whitelist);
    ctx(&alice(), 0);
    c.remove_trusted_pipeline(pipeline_account());
}

#[test]
fn schema_registration_first_wins() {
    let mut c = setup(ResolverKind::Fee);
    ctx(&schemas(), 0);
    assert!(c.on_schema_registered(SCHEMA, admin()));
    assert!(!c.on_schema_registered(SCHEMA, alice()));
    assert_eq!(c.schema_admin(SCHEMA), Some(admin()));
    // A trusted pipeline may register too.
    ctx(&owner(), 0);
    c.add_trusted_pipeline(pipeline_account());
    ctx(&pipeline_account(), 0);
    assert!(c.on_schema_registered(OTHER_SCHEMA, alice()));
    assert_eq!(c.schema_admin(OTHER_SCHEMA), Some(alice()));
    assert_eq!(event_names(), vec!["resolver_configured"]);
}

#[test]
#[should_panic(expected = "only the schemas contract or a trusted pipeline")]
fn schema_registration_rejects_strangers() {
    let mut c = setup(ResolverKind::Fee);
    ctx(&alice(), 0);
    c.on_schema_registered(OTHER_SCHEMA, alice());
}

#[test]
#[should_panic(expected = "only the schemas contract or a trusted pipeline")]
fn schema_registration_rejects_attestations() {
    let mut c = setup(ResolverKind::Fee);
    ctx(&attestations(), 0);
    c.on_schema_registered(OTHER_SCHEMA, alice());
}

#[test]
#[should_panic(expected = "only the attestations contract or a trusted pipeline")]
fn on_attest_rejects_strangers() {
    let mut c = setup(ResolverKind::TokenReward);
    ctx(&alice(), 0);
    let _ = c.on_attest(attest(&alice()));
}

#[test]
#[should_panic(expected = "only the attestations contract or a trusted pipeline")]
fn on_revoke_rejects_strangers() {
    let mut c = setup(ResolverKind::TokenReward);
    ctx(&schemas(), 0);
    let _ = c.on_revoke(attest(&alice()));
}

#[test]
#[should_panic(expected = "only the attestations contract or a trusted pipeline")]
fn on_aborted_rejects_strangers() {
    let mut c = setup(ResolverKind::Fee);
    ctx(&alice(), 0);
    c.on_aborted(attest(&alice()));
}

#[test]
#[should_panic(expected = "only the attestations contract or a trusted pipeline")]
fn on_committed_rejects_strangers() {
    let mut c = setup(ResolverKind::Fee);
    ctx(&alice(), 0);
    c.on_committed(attest(&alice()));
}

#[test]
fn trusted_pipeline_can_call_hooks() {
    let mut c = setup(ResolverKind::TokenReward);
    ctx(&owner(), 0);
    c.add_trusted_pipeline(pipeline_account());
    ctx(&pipeline_account(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    assert!(value(c.on_revoke(attest(&alice()))));
    c.on_aborted(attest(&alice()));
    c.on_committed(attest(&alice()));
}

#[test]
#[should_panic(expected = "only the attestations contract or a trusted pipeline")]
fn removed_pipeline_loses_hook_access() {
    let mut c = setup(ResolverKind::TokenReward);
    ctx(&owner(), 0);
    c.add_trusted_pipeline(pipeline_account());
    c.remove_trusted_pipeline(pipeline_account());
    ctx(&pipeline_account(), 0);
    let _ = c.on_attest(attest(&alice()));
}

macro_rules! wrong_kind {
    ($name:ident, $kind:expr, $expected:literal, |$c:ident| $body:expr) => {
        #[test]
        #[should_panic(expected = $expected)]
        fn $name() {
            #[allow(unused_mut)]
            let mut $c = setup($kind);
            ctx(&admin(), NEAR);
            let _ = $body;
        }
    };
}

wrong_kind!(whitelist_add_on_fee, ResolverKind::Fee, "not a whitelist resolver", |c| c
    .whitelist_add(SCHEMA, alice()));
wrong_kind!(is_whitelisted_on_gate, ResolverKind::TokenGated, "not a whitelist resolver", |c| c
    .is_whitelisted(SCHEMA, alice()));
wrong_kind!(set_fee_on_whitelist, ResolverKind::Whitelist, "not a fee resolver", |c| c.set_fee(
    SCHEMA,
    None,
    U128(1)
));
wrong_kind!(deposit_on_reward, ResolverKind::TokenReward, "not a fee resolver", |c| c.deposit());
wrong_kind!(withdraw_fees_on_pipeline, ResolverKind::Pipeline, "not a fee resolver", |c| c
    .withdraw_fees(SCHEMA, None));
wrong_kind!(set_gate_on_fee, ResolverKind::Fee, "not a token_gated resolver", |c| c.set_gate(
    SCHEMA,
    token(),
    U128(1)
));
wrong_kind!(set_reward_on_gate, ResolverKind::TokenGated, "not a token_reward resolver", |c| c.set_reward(
    SCHEMA,
    token(),
    U128(1)
));
wrong_kind!(distributed_on_fee, ResolverKind::Fee, "not a token_reward resolver", |c| c
    .distributed(SCHEMA, alice()));
wrong_kind!(set_pipeline_on_whitelist, ResolverKind::Whitelist, "not a pipeline resolver", |c| c
    .set_pipeline(SCHEMA, vec![alice()]));
wrong_kind!(get_pipeline_on_reward, ResolverKind::TokenReward, "not a pipeline resolver", |c| c
    .get_pipeline(SCHEMA));
wrong_kind!(
    ft_on_transfer_on_whitelist,
    ResolverKind::Whitelist,
    "not a fee or token_reward resolver",
    |c| c.ft_on_transfer(alice(), U128(5), String::new())
);

#[test]
#[should_panic(expected = "only the schema admin")]
fn setters_require_the_admin() {
    let mut c = setup(ResolverKind::Whitelist);
    ctx(&alice(), NEAR);
    c.whitelist_add(SCHEMA, alice());
}

#[test]
#[should_panic(expected = "the schema is not registered with this resolver")]
fn setters_require_a_registered_schema() {
    let mut c = setup(ResolverKind::Fee);
    ctx(&admin(), NEAR);
    c.set_fee(OTHER_SCHEMA, None, U128(1));
}

// Whitelist

#[test]
fn whitelist_add_charges_storage_and_refunds_the_rest() {
    let mut c = setup(ResolverKind::Whitelist);
    ctx(&admin(), NEAR);
    let before = env::storage_usage();
    c.whitelist_add(SCHEMA, alice());
    let cost = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
    assert!(cost > 0);
    assert_eq!(transfers(), vec![(admin(), NEAR - cost)]);
    assert!(c.is_whitelisted(SCHEMA, alice()));
    assert!(!c.is_whitelisted(OTHER_SCHEMA, alice()));
    let e = &events()[0];
    assert_eq!(e["event"], "resolver_configured");
    assert_eq!(e["data"][0]["setting"], "whitelist_added");
    assert_eq!(e["data"][0]["value"], "alice.testnet");
}

#[test]
fn whitelist_add_with_exact_deposit_refunds_nothing() {
    let mut c = setup(ResolverKind::Whitelist);
    ctx(&admin(), NEAR);
    let before = env::storage_usage();
    c.whitelist_add(SCHEMA, alice());
    let cost = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
    ctx(&admin(), cost);
    c.whitelist_add(SCHEMA, acc("carol.testnet"));
    assert!(transfers().is_empty());
    // Adding an account twice writes nothing and refunds the whole deposit.
    ctx(&admin(), 5);
    c.whitelist_add(SCHEMA, acc("carol.testnet"));
    assert_eq!(transfers(), vec![(admin(), 5)]);
    assert!(event_names().is_empty());
}

#[test]
#[should_panic(expected = "attach at least")]
fn whitelist_add_without_deposit_panics() {
    let mut c = setup(ResolverKind::Whitelist);
    ctx(&admin(), 0);
    c.whitelist_add(SCHEMA, alice());
}

#[test]
fn whitelist_gates_attesters() {
    let mut c = setup(ResolverKind::Whitelist);
    ctx(&admin(), NEAR);
    c.whitelist_add(SCHEMA, alice());
    ctx(&attestations(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    assert!(!value(c.on_attest(attest(&bob()))));
    assert!(get_logs().iter().any(|l| l.contains("bob.testnet is not whitelisted")));
    // The subject does not matter, only the attester.
    assert!(!value(c.on_attest(resolver_call(ResolverOp::Attest, &bob(), "alice.testnet"))));
    assert!(value(c.on_revoke(attest(&bob()))));
    ctx(&admin(), 7);
    c.whitelist_remove(SCHEMA, alice());
    assert_eq!(transfers(), vec![(admin(), 7)]);
    assert_eq!(events()[0]["data"][0]["setting"], "whitelist_removed");
    assert!(!c.is_whitelisted(SCHEMA, alice()));
    ctx(&attestations(), 0);
    assert!(!value(c.on_attest(attest(&alice()))));
}

#[test]
fn whitelist_hooks_without_side_effects() {
    let mut c = setup(ResolverKind::Whitelist);
    ctx(&attestations(), 0);
    c.on_aborted(attest(&alice()));
    c.on_committed(attest(&alice()));
    assert!(get_created_receipts().is_empty());
}

#[test]
#[should_panic(expected = "only the schema admin")]
fn whitelist_remove_requires_admin() {
    let mut c = setup(ResolverKind::Whitelist);
    ctx(&alice(), 0);
    c.whitelist_remove(SCHEMA, alice());
}

// Fee

fn fee_setup(fee_token: Option<AccountId>, amount: u128) -> Contract {
    let mut c = setup(ResolverKind::Fee);
    ctx(&admin(), NEAR);
    c.set_fee(SCHEMA, fee_token, U128(amount));
    c
}

#[test]
fn fee_set_and_get() {
    let mut c = fee_setup(None, 100);
    assert_eq!(c.get_fee(SCHEMA), Some(FeeView { token: None, amount: U128(100) }));
    assert_eq!(c.get_fee(OTHER_SCHEMA), None);
    assert_eq!(events()[0]["data"][0]["setting"], "fee");
    ctx(&admin(), NEAR);
    c.set_fee(SCHEMA, Some(token()), U128(5));
    assert_eq!(c.get_fee(SCHEMA), Some(FeeView { token: Some(token()), amount: U128(5) }));
    let json = serde_json::to_value(c.get_fee(SCHEMA)).unwrap();
    assert_eq!(json, serde_json::json!({ "token": "token.testnet", "amount": "5" }));
}

#[test]
fn fee_near_deposit_credits_the_caller() {
    let mut c = fee_setup(None, 100);
    ctx(&alice(), 250);
    assert_eq!(c.deposit(), U128(250));
    ctx(&alice(), 50);
    assert_eq!(c.deposit(), U128(300));
    assert_eq!(c.balance_of(alice(), None), U128(300));
    assert_eq!(c.balance_of(alice(), Some(token())), U128(0));
    assert_eq!(c.balance_of(bob(), None), U128(0));
    let e = &events()[0];
    assert_eq!(e["event"], "fee_deposited");
    assert_eq!(e["data"][0]["amount"], "50");
    assert_eq!(e["data"][0]["balance"], "300");
    assert_eq!(e["data"][0]["token"], serde_json::Value::Null);
}

#[test]
#[should_panic(expected = "attach the NEAR to deposit")]
fn fee_deposit_requires_near() {
    let mut c = fee_setup(None, 100);
    ctx(&alice(), 0);
    c.deposit();
}

#[test]
fn fee_token_deposit_through_ft_on_transfer() {
    let mut c = fee_setup(Some(token()), 100);
    ctx(&token(), 0);
    assert_eq!(c.ft_on_transfer(alice(), U128(40), String::new()), U128(0));
    assert_eq!(c.ft_on_transfer(alice(), U128(60), "deposit".into()), U128(0));
    assert_eq!(c.balance_of(alice(), Some(token())), U128(100));
    assert_eq!(event_names(), vec!["fee_deposited", "fee_deposited"]);
    // Unknown messages are refunded in full and credit nothing.
    assert_eq!(c.ft_on_transfer(alice(), U128(70), "stake".into()), U128(70));
    assert_eq!(c.balance_of(alice(), Some(token())), U128(100));
    // Each calling token keeps its own balance.
    ctx(&acc("other-token.testnet"), 0);
    assert_eq!(c.ft_on_transfer(alice(), U128(3), String::new()), U128(0));
    assert_eq!(c.balance_of(alice(), Some(acc("other-token.testnet"))), U128(3));
    assert_eq!(c.balance_of(alice(), Some(token())), U128(100));
}

#[test]
fn fee_free_schemas_pass() {
    let mut c = setup(ResolverKind::Fee);
    ctx(&attestations(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    ctx(&admin(), NEAR);
    c.set_fee(SCHEMA, None, U128(0));
    ctx(&attestations(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    assert!(event_names().is_empty());
}

#[test]
fn fee_refused_when_balance_is_short() {
    let mut c = fee_setup(None, 100);
    ctx(&alice(), 99);
    c.deposit();
    ctx(&attestations(), 0);
    assert!(!value(c.on_attest(attest(&alice()))));
    assert_eq!(c.balance_of(alice(), None), U128(99));
    assert!(event_names().is_empty());
    // The attester pays, not the actor.
    ctx(&bob(), 1_000);
    c.deposit();
    ctx(&attestations(), 0);
    let mut call = attest(&alice());
    call.actor = bob();
    assert!(!value(c.on_attest(call)));
}

#[test]
fn fee_charge_then_commit() {
    let mut c = fee_setup(None, 100);
    ctx(&alice(), 250);
    c.deposit();
    ctx(&attestations(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    assert_eq!(c.balance_of(alice(), None), U128(150));
    assert_eq!(c.collected(SCHEMA, None), U128(0));
    let e = &events()[0];
    assert_eq!(e["event"], "fee_charged");
    assert_eq!(e["data"][0]["payer"], "alice.testnet");
    assert_eq!(e["data"][0]["amount"], "100");
    assert_eq!(e["data"][0]["attestation_uid"], ATTESTATION.to_hex());
    c.on_committed(attest(&alice()));
    assert_eq!(c.collected(SCHEMA, None), U128(100));
    // Commit and abort after a commit change nothing.
    c.on_committed(attest(&alice()));
    c.on_aborted(attest(&alice()));
    assert_eq!(c.collected(SCHEMA, None), U128(100));
    assert_eq!(c.balance_of(alice(), None), U128(150));
}

#[test]
fn fee_charge_then_abort_refunds() {
    let mut c = fee_setup(Some(token()), 30);
    ctx(&token(), 0);
    c.ft_on_transfer(alice(), U128(30), String::new());
    ctx(&attestations(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    assert_eq!(c.balance_of(alice(), Some(token())), U128(0));
    c.on_aborted(attest(&alice()));
    assert_eq!(c.balance_of(alice(), Some(token())), U128(30));
    assert_eq!(c.collected(SCHEMA, Some(token())), U128(0));
    assert_eq!(event_names(), vec!["fee_charged", "fee_refunded"]);
    assert_eq!(events()[1]["data"][0]["token"], "token.testnet");
    // A second abort and a late commit change nothing.
    c.on_aborted(attest(&alice()));
    c.on_committed(attest(&alice()));
    assert_eq!(c.balance_of(alice(), Some(token())), U128(30));
    assert_eq!(c.collected(SCHEMA, Some(token())), U128(0));
}

#[test]
fn fee_charges_each_attestation_once() {
    let mut c = fee_setup(None, 10);
    ctx(&alice(), 100);
    c.deposit();
    ctx(&attestations(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    assert!(!value(c.on_attest(attest(&alice()))));
    assert_eq!(c.balance_of(alice(), None), U128(90));
    let mut second = attest(&alice());
    second.attestation_uid = Uid([10; 32]);
    assert!(value(c.on_attest(second)));
    assert_eq!(c.balance_of(alice(), None), U128(80));
}

#[test]
fn fee_charge_keeps_the_token_it_was_charged_in() {
    let mut c = fee_setup(None, 10);
    ctx(&alice(), 10);
    c.deposit();
    ctx(&attestations(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    // The admin switches the fee to a token while the attestation is in flight.
    ctx(&admin(), NEAR);
    c.set_fee(SCHEMA, Some(token()), U128(99));
    ctx(&attestations(), 0);
    c.on_aborted(attest(&alice()));
    assert_eq!(c.balance_of(alice(), None), U128(10));
    assert_eq!(c.balance_of(alice(), Some(token())), U128(0));
}

#[test]
fn fee_withdraw_near_balance() {
    let mut c = fee_setup(None, 10);
    ctx(&alice(), 100);
    c.deposit();
    ctx(&alice(), 0);
    let _ = c.withdraw_balance(None, Some(U128(40)));
    assert_eq!(c.balance_of(alice(), None), U128(60));
    assert_eq!(transfers(), vec![(alice(), 40)]);
    let cb = calls();
    assert_eq!(cb.len(), 1);
    assert_eq!(cb[0].receiver, me());
    assert_eq!(cb[0].method, "balance_withdrawn");
    assert_eq!(
        cb[0].args,
        serde_json::json!({ "account_id": "alice.testnet", "token": null, "amount": "40" })
    );
    callback(vec![PromiseResult::Successful(vec![])]);
    assert_eq!(c.balance_withdrawn(alice(), None, U128(40)), U128(40));
    assert_eq!(c.balance_of(alice(), None), U128(60));
    let e = &events()[0];
    assert_eq!(e["event"], "fee_withdrawn");
    assert_eq!(e["data"][0]["balance"], "60");
}

#[test]
fn fee_withdraw_all_and_restore_on_failure() {
    let mut c = fee_setup(Some(token()), 10);
    ctx(&token(), 0);
    c.ft_on_transfer(alice(), U128(80), String::new());
    ctx(&alice(), 0);
    let _ = c.withdraw_balance(Some(token()), None);
    assert_eq!(c.balance_of(alice(), Some(token())), U128(0));
    let cs = calls();
    assert_eq!(cs[0].receiver, token());
    assert_eq!(cs[0].method, "ft_transfer");
    assert_eq!(cs[0].deposit, 1);
    assert_eq!(
        cs[0].args,
        serde_json::json!({ "receiver_id": "alice.testnet", "amount": "80", "memo": null })
    );
    assert_eq!(cs[1].method, "balance_withdrawn");
    callback(vec![PromiseResult::Failed]);
    assert_eq!(c.balance_withdrawn(alice(), Some(token()), U128(80)), U128(0));
    assert_eq!(c.balance_of(alice(), Some(token())), U128(80));
    assert!(event_names().is_empty());
}

#[test]
#[should_panic(expected = "amount exceeds the prepaid balance")]
fn fee_withdraw_more_than_the_balance() {
    let mut c = fee_setup(None, 10);
    ctx(&alice(), 5);
    c.deposit();
    ctx(&alice(), 0);
    let _ = c.withdraw_balance(None, Some(U128(6)));
}

#[test]
#[should_panic(expected = "nothing to withdraw")]
fn fee_withdraw_empty_balance() {
    let mut c = fee_setup(None, 10);
    ctx(&alice(), 0);
    let _ = c.withdraw_balance(None, None);
}

#[test]
fn fee_admin_withdraws_collected_fees() {
    let mut c = fee_setup(None, 100);
    ctx(&alice(), 100);
    c.deposit();
    ctx(&attestations(), 0);
    let _ = c.on_attest(attest(&alice()));
    c.on_committed(attest(&alice()));
    ctx(&admin(), 0);
    let _ = c.withdraw_fees(SCHEMA, None);
    assert_eq!(c.collected(SCHEMA, None), U128(0));
    assert_eq!(transfers(), vec![(admin(), 100)]);
    assert_eq!(calls()[0].method, "fees_withdrawn");
    callback(vec![PromiseResult::Successful(vec![])]);
    assert_eq!(c.fees_withdrawn(SCHEMA, None, admin(), U128(100)), U128(100));
    assert_eq!(event_names(), vec!["fees_claimed"]);
    assert_eq!(c.collected(SCHEMA, None), U128(0));
}

#[test]
fn fee_failed_fee_withdrawal_is_restored() {
    let mut c = fee_setup(Some(token()), 100);
    ctx(&token(), 0);
    c.ft_on_transfer(alice(), U128(100), String::new());
    ctx(&attestations(), 0);
    let _ = c.on_attest(attest(&alice()));
    c.on_committed(attest(&alice()));
    ctx(&admin(), 0);
    let _ = c.withdraw_fees(SCHEMA, Some(token()));
    let cs = calls();
    assert_eq!(cs[0].method, "ft_transfer");
    assert_eq!(cs[0].args["receiver_id"], "admin.testnet");
    callback(vec![PromiseResult::Failed]);
    assert_eq!(c.fees_withdrawn(SCHEMA, Some(token()), admin(), U128(100)), U128(0));
    assert_eq!(c.collected(SCHEMA, Some(token())), U128(100));
}

#[test]
#[should_panic(expected = "only the schema admin")]
fn fee_withdraw_fees_requires_admin() {
    let mut c = fee_setup(None, 100);
    ctx(&alice(), 0);
    let _ = c.withdraw_fees(SCHEMA, None);
}

#[test]
#[should_panic(expected = "no fees collected")]
fn fee_withdraw_fees_requires_fees() {
    let mut c = fee_setup(None, 100);
    ctx(&admin(), 0);
    let _ = c.withdraw_fees(SCHEMA, None);
}

#[test]
fn fee_in_flight_charges_are_not_withdrawable() {
    let mut c = fee_setup(None, 100);
    ctx(&alice(), 100);
    c.deposit();
    ctx(&attestations(), 0);
    let _ = c.on_attest(attest(&alice()));
    assert_eq!(c.collected(SCHEMA, None), U128(0));
    // The abort still finds the whole charge.
    c.on_aborted(attest(&alice()));
    assert_eq!(c.balance_of(alice(), None), U128(100));
}

// Token gated

fn gate_setup(min: u128) -> Contract {
    let mut c = setup(ResolverKind::TokenGated);
    ctx(&admin(), NEAR);
    c.set_gate(SCHEMA, token(), U128(min));
    c
}

#[test]
fn gate_set_and_get() {
    let c = gate_setup(500);
    assert_eq!(c.get_gate(SCHEMA), Some(GateView { token: token(), min_balance: U128(500) }));
    assert_eq!(c.get_gate(OTHER_SCHEMA), None);
    assert_eq!(events()[0]["data"][0]["setting"], "gate");
}

#[test]
fn gate_without_config_passes() {
    let mut c = setup(ResolverKind::TokenGated);
    ctx(&attestations(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    assert!(value(c.on_revoke(attest(&alice()))));
    assert!(get_created_receipts().is_empty());
}

#[test]
fn gate_reads_the_attester_balance() {
    let mut c = gate_setup(500);
    ctx(&attestations(), 0);
    match c.on_attest(attest(&alice())) {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(_) => panic!("expected a promise"),
    }
    let cs = calls();
    assert_eq!(cs.len(), 2);
    assert_eq!(cs[0].receiver, token());
    assert_eq!(cs[0].method, "ft_balance_of");
    assert_eq!(cs[0].args, serde_json::json!({ "account_id": "alice.testnet" }));
    assert_eq!(cs[1].receiver, me());
    assert_eq!(cs[1].method, "gate_checked");
    assert_eq!(cs[1].args, serde_json::json!({ "min_balance": "500" }));
    // Revocations are not gated.
    ctx(&attestations(), 0);
    assert!(value(c.on_revoke(attest(&alice()))));
}

#[test]
fn gate_checked_compares_the_balance() {
    let c = gate_setup(500);
    callback(vec![ok_json(&U128(500))]);
    assert!(c.gate_checked(U128(500)));
    callback(vec![ok_json(&U128(10_000))]);
    assert!(c.gate_checked(U128(500)));
    callback(vec![ok_json(&U128(499))]);
    assert!(!c.gate_checked(U128(500)));
    assert!(get_logs()[0].contains("below the minimum"));
    callback(vec![PromiseResult::Failed]);
    assert!(!c.gate_checked(U128(500)));
    callback(vec![PromiseResult::Successful(b"\"not a number\"".to_vec())]);
    assert!(!c.gate_checked(U128(500)));
    callback(vec![PromiseResult::Successful(vec![b'1'; 100])]);
    assert!(!c.gate_checked(U128(500)));
    callback(vec![]);
    assert!(!c.gate_checked(U128(0)));
}

// Token reward

fn reward_setup(amount: u128, pool: u128) -> Contract {
    let mut c = setup(ResolverKind::TokenReward);
    ctx(&admin(), NEAR);
    c.set_reward(SCHEMA, token(), U128(amount));
    if pool > 0 {
        ctx(&token(), 0);
        assert_eq!(c.ft_on_transfer(admin(), U128(pool), fund_msg(&SCHEMA)), U128(0));
    }
    c
}

fn fund_msg(schema: &Uid) -> String {
    format!("{{\"fund\":\"{}\"}}", schema.to_hex())
}

#[test]
fn reward_set_and_fund() {
    let mut c = reward_setup(10, 0);
    let view = c.get_reward(SCHEMA).unwrap();
    assert_eq!(
        view,
        RewardView { token: token(), amount: U128(10), pool: U128(0), distributed_total: U128(0) }
    );
    assert_eq!(c.get_reward(OTHER_SCHEMA), None);
    ctx(&token(), 0);
    assert_eq!(c.ft_on_transfer(alice(), U128(25), fund_msg(&SCHEMA)), U128(0));
    assert_eq!(c.get_reward(SCHEMA).unwrap().pool, U128(25));
    let e = &events()[0];
    assert_eq!(e["event"], "reward_funded");
    assert_eq!(e["data"][0]["sender_id"], "alice.testnet");
    assert_eq!(e["data"][0]["pool"], "25");
    let json = serde_json::to_value(c.get_reward(SCHEMA)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "token": "token.testnet", "amount": "10", "pool": "25", "distributed_total": "0" })
    );
}

#[test]
fn reward_funding_refuses_anything_else() {
    let mut c = reward_setup(10, 0);
    ctx(&acc("other-token.testnet"), 0);
    assert_eq!(c.ft_on_transfer(alice(), U128(25), fund_msg(&SCHEMA)), U128(25));
    ctx(&token(), 0);
    assert_eq!(c.ft_on_transfer(alice(), U128(25), fund_msg(&OTHER_SCHEMA)), U128(25));
    assert_eq!(c.ft_on_transfer(alice(), U128(25), String::new()), U128(25));
    assert_eq!(c.ft_on_transfer(alice(), U128(25), "{\"fund\":\"abc\"}".into()), U128(25));
    assert_eq!(c.ft_on_transfer(alice(), U128(25), format!("{{\"fund\":\"{}\",\"x\":1}}", SCHEMA)), U128(25));
    assert_eq!(c.get_reward(SCHEMA).unwrap().pool, U128(0));
    assert!(event_names().is_empty());
}

#[test]
fn reward_hooks_approve() {
    let mut c = reward_setup(10, 100);
    ctx(&attestations(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    assert!(value(c.on_revoke(attest(&alice()))));
    c.on_aborted(attest(&alice()));
    assert!(get_created_receipts().is_empty());
}

#[test]
fn reward_paid_on_commit() {
    let mut c = reward_setup(10, 25);
    ctx(&attestations(), 0);
    c.on_committed(attest(&alice()));
    assert_eq!(c.get_reward(SCHEMA).unwrap().pool, U128(15));
    let cs = calls();
    assert_eq!(cs.len(), 3);
    assert_eq!(cs[0].receiver, token());
    assert_eq!(cs[0].method, "storage_deposit");
    assert_eq!(cs[0].deposit, 1_250_000_000_000_000_000_000);
    assert_eq!(cs[0].args, serde_json::json!({ "account_id": "bob.testnet", "registration_only": true }));
    assert_eq!(cs[1].receiver, token());
    assert_eq!(cs[1].method, "ft_transfer");
    assert_eq!(cs[1].deposit, 1);
    assert_eq!(cs[1].args["receiver_id"], "bob.testnet");
    assert_eq!(cs[1].args["amount"], "10");
    assert_eq!(cs[2].receiver, me());
    assert_eq!(cs[2].method, "reward_settled");
    assert_eq!(
        cs[2].args,
        serde_json::json!({ "schema_uid": SCHEMA.to_hex(), "subject": "bob.testnet", "amount": "10" })
    );
    // The transfer waits for the storage deposit and the callback for the transfer.
    let receipts = get_created_receipts();
    assert!(receipts[0].receipt_indices.is_empty());
    assert_eq!(receipts[1].receipt_indices, vec![receipt_index(&receipts[0])]);
    assert_eq!(receipts[2].receipt_indices, vec![receipt_index(&receipts[1])]);

    callback(vec![PromiseResult::Successful(vec![])]);
    assert!(c.reward_settled(SCHEMA, bob(), U128(10)));
    assert_eq!(c.distributed(SCHEMA, bob()), U128(10));
    assert_eq!(c.distributed(SCHEMA, alice()), U128(0));
    let view = c.get_reward(SCHEMA).unwrap();
    assert_eq!(view.distributed_total, U128(10));
    assert_eq!(view.pool, U128(15));
    let e = &events()[0];
    assert_eq!(e["event"], "reward_paid");
    assert_eq!(e["data"][0]["account_id"], "bob.testnet");
    assert_eq!(e["data"][0]["amount"], "10");
}

#[test]
fn reward_failure_returns_to_the_pool() {
    let mut c = reward_setup(10, 10);
    ctx(&attestations(), 0);
    c.on_committed(attest(&alice()));
    assert_eq!(c.get_reward(SCHEMA).unwrap().pool, U128(0));
    callback(vec![PromiseResult::Failed]);
    assert!(!c.reward_settled(SCHEMA, bob(), U128(10)));
    let view = c.get_reward(SCHEMA).unwrap();
    assert_eq!(view.pool, U128(10));
    assert_eq!(view.distributed_total, U128(0));
    assert_eq!(c.distributed(SCHEMA, bob()), U128(0));
    assert!(event_names().is_empty());
}

#[test]
fn reward_skipped_when_it_cannot_be_paid() {
    let mut c = reward_setup(10, 15);
    ctx(&attestations(), 0);
    // Subject on another chain.
    c.on_committed(resolver_call(
        ResolverOp::Attest,
        &alice(),
        "eip155:1:0xab5801a7d398351b8be11c439e05c5b3259aec9b",
    ));
    // Revocations and schedules pay nothing.
    c.on_committed(resolver_call(ResolverOp::Revoke, &alice(), "bob.testnet"));
    c.on_committed(resolver_call(ResolverOp::Schedule, &alice(), "bob.testnet"));
    // A schema without a reward.
    let mut other = attest(&alice());
    other.schema_uid = OTHER_SCHEMA;
    c.on_committed(other);
    assert!(get_created_receipts().is_empty());
    assert_eq!(c.get_reward(SCHEMA).unwrap().pool, U128(15));
    // The first payout empties the pool below the reward; the second is skipped.
    c.on_committed(attest(&alice()));
    c.on_committed(attest(&alice()));
    assert_eq!(calls().iter().filter(|c| c.method == "ft_transfer").count(), 1);
    assert_eq!(c.get_reward(SCHEMA).unwrap().pool, U128(5));
}

#[test]
fn reward_zero_amount_pays_nothing() {
    let mut c = reward_setup(0, 15);
    ctx(&attestations(), 0);
    c.on_committed(attest(&alice()));
    assert!(get_created_receipts().is_empty());
}

#[test]
fn reward_amount_can_change() {
    let mut c = reward_setup(10, 15);
    ctx(&admin(), NEAR);
    c.set_reward(SCHEMA, token(), U128(3));
    assert_eq!(c.get_reward(SCHEMA).unwrap().amount, U128(3));
    assert_eq!(c.get_reward(SCHEMA).unwrap().pool, U128(15));
}

#[test]
fn reward_token_can_change_before_funding() {
    let mut c = reward_setup(10, 0);
    ctx(&admin(), NEAR);
    c.set_reward(SCHEMA, acc("other-token.testnet"), U128(10));
    assert_eq!(c.get_reward(SCHEMA).unwrap().token, acc("other-token.testnet"));
}

#[test]
#[should_panic(expected = "the reward token cannot change")]
fn reward_token_locked_after_funding() {
    let mut c = reward_setup(10, 15);
    ctx(&admin(), NEAR);
    c.set_reward(SCHEMA, acc("other-token.testnet"), U128(10));
}

#[test]
#[should_panic(expected = "the reward token cannot change")]
fn reward_token_locked_while_a_payout_is_pending() {
    let mut c = reward_setup(10, 10);
    ctx(&attestations(), 0);
    c.on_committed(attest(&alice()));
    ctx(&admin(), NEAR);
    c.set_reward(SCHEMA, acc("other-token.testnet"), U128(10));
}

#[test]
fn reward_pool_withdrawal() {
    let mut c = reward_setup(10, 30);
    ctx(&admin(), 0);
    let _ = c.withdraw_reward_pool(SCHEMA, Some(U128(12)));
    assert_eq!(c.get_reward(SCHEMA).unwrap().pool, U128(18));
    let cs = calls();
    assert_eq!(cs[0].method, "ft_transfer");
    assert_eq!(cs[0].args["receiver_id"], "admin.testnet");
    assert_eq!(cs[0].args["amount"], "12");
    assert_eq!(cs[1].method, "pool_withdrawn");
    callback(vec![PromiseResult::Successful(vec![])]);
    assert_eq!(c.pool_withdrawn(SCHEMA, admin(), U128(12)), U128(12));
    assert_eq!(event_names(), vec!["reward_pool_withdrawn"]);
    // Withdrawing the rest fails and is put back.
    ctx(&admin(), 0);
    let _ = c.withdraw_reward_pool(SCHEMA, None);
    assert_eq!(c.get_reward(SCHEMA).unwrap().pool, U128(0));
    callback(vec![PromiseResult::Failed]);
    assert_eq!(c.pool_withdrawn(SCHEMA, admin(), U128(18)), U128(0));
    assert_eq!(c.get_reward(SCHEMA).unwrap().pool, U128(18));
}

#[test]
#[should_panic(expected = "amount exceeds the reward pool")]
fn reward_pool_withdrawal_is_bounded() {
    let mut c = reward_setup(10, 30);
    ctx(&admin(), 0);
    let _ = c.withdraw_reward_pool(SCHEMA, Some(U128(31)));
}

#[test]
#[should_panic(expected = "only the schema admin")]
fn reward_pool_withdrawal_requires_admin() {
    let mut c = reward_setup(10, 30);
    ctx(&alice(), 0);
    let _ = c.withdraw_reward_pool(SCHEMA, None);
}

#[test]
#[should_panic(expected = "no reward is configured")]
fn reward_pool_withdrawal_requires_a_reward() {
    let mut c = setup(ResolverKind::TokenReward);
    ctx(&admin(), 0);
    let _ = c.withdraw_reward_pool(SCHEMA, None);
}

// Pipeline

fn r(n: u8) -> AccountId {
    acc(&format!("r{n}.testnet"))
}

fn pipeline_setup(resolvers: Vec<AccountId>) -> Contract {
    let mut c = setup(ResolverKind::Pipeline);
    let n = resolvers.len();
    callback((0..n).map(|_| ok_json(&true)).collect());
    assert!(c.pipeline_configured(SCHEMA, resolvers, admin(), U128(NEAR)));
    c
}

#[test]
fn set_pipeline_registers_with_every_resolver() {
    let mut c = setup(ResolverKind::Pipeline);
    ctx(&admin(), NEAR);
    let _ = c.set_pipeline(SCHEMA, vec![r(1), r(2), r(3)]);
    let cs = calls();
    assert_eq!(cs.len(), 4);
    for (i, call) in cs.iter().take(3).enumerate() {
        assert_eq!(call.receiver, r(i as u8 + 1));
        assert_eq!(call.method, "on_schema_registered");
        assert_eq!(
            call.args,
            serde_json::json!({ "schema_uid": SCHEMA.to_hex(), "authority": "admin.testnet" })
        );
    }
    assert_eq!(cs[3].receiver, me());
    assert_eq!(cs[3].method, "pipeline_configured");
    assert_eq!(cs[3].args["payer"], "admin.testnet");
    assert_eq!(cs[3].args["deposit"], NEAR.to_string());
    assert_eq!(cs[3].args["resolvers"], serde_json::json!(["r1.testnet", "r2.testnet", "r3.testnet"]));
    // Nothing is stored before the callback.
    assert!(c.get_pipeline(SCHEMA).is_empty());
}

#[test]
fn pipeline_configured_stores_when_all_accept() {
    let mut c = setup(ResolverKind::Pipeline);
    callback(vec![ok_json(&true), ok_json(&true)]);
    let before = env::storage_usage();
    assert!(c.pipeline_configured(SCHEMA, vec![r(1), r(2)], admin(), U128(NEAR)));
    let cost = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
    assert_eq!(c.get_pipeline(SCHEMA), vec![r(1), r(2)]);
    assert_eq!(transfers(), vec![(admin(), NEAR - cost)]);
    let e = &events()[0];
    assert_eq!(e["data"][0]["setting"], "pipeline");
    assert_eq!(e["data"][0]["value"], serde_json::json!(["r1.testnet", "r2.testnet"]));
}

#[test]
fn pipeline_configured_stores_nothing_on_a_refusal() {
    let mut c = setup(ResolverKind::Pipeline);
    callback(vec![ok_json(&true), ok_json(&false)]);
    assert!(!c.pipeline_configured(SCHEMA, vec![r(1), r(2)], admin(), U128(NEAR)));
    assert!(c.get_pipeline(SCHEMA).is_empty());
    assert_eq!(transfers(), vec![(admin(), NEAR)]);
    assert!(get_logs().iter().any(|l| l.contains("r2.testnet")));
    assert!(event_names().is_empty());
}

#[test]
fn pipeline_configured_stores_nothing_on_a_failure() {
    let mut c = setup(ResolverKind::Pipeline);
    callback(vec![PromiseResult::Failed, ok_json(&true)]);
    assert!(!c.pipeline_configured(SCHEMA, vec![r(1), r(2)], admin(), U128(5)));
    assert!(c.get_pipeline(SCHEMA).is_empty());
    assert_eq!(transfers(), vec![(admin(), 5)]);
    // A non-bool answer counts as a refusal.
    callback(vec![ok_json(&"yes")]);
    assert!(!c.pipeline_configured(SCHEMA, vec![r(1)], admin(), U128(0)));
    // Missing results count as a refusal.
    callback(vec![ok_json(&true)]);
    assert!(!c.pipeline_configured(SCHEMA, vec![r(1), r(2)], admin(), U128(0)));
    assert!(c.get_pipeline(SCHEMA).is_empty());
}

#[test]
fn pipeline_configured_needs_the_storage_deposit() {
    let mut c = pipeline_setup(vec![r(1)]);
    callback(vec![ok_json(&true), ok_json(&true), ok_json(&true)]);
    assert!(!c.pipeline_configured(SCHEMA, vec![r(1), r(2), r(3)], admin(), U128(1)));
    assert_eq!(c.get_pipeline(SCHEMA), vec![r(1)]);
    assert_eq!(transfers(), vec![(admin(), 1)]);
    assert!(get_logs().iter().any(|l| l.contains("attach at least")));
}

#[test]
fn pipeline_configured_without_deposit_leaves_nothing() {
    let mut c = setup(ResolverKind::Pipeline);
    callback(vec![ok_json(&true)]);
    let before = env::storage_usage();
    assert!(!c.pipeline_configured(SCHEMA, vec![r(1)], admin(), U128(0)));
    assert!(c.get_pipeline(SCHEMA).is_empty());
    assert_eq!(env::storage_usage(), before);
    assert!(transfers().is_empty());
}

macro_rules! bad_pipeline {
    ($name:ident, $resolvers:expr, $expected:literal) => {
        #[test]
        #[should_panic(expected = $expected)]
        fn $name() {
            let mut c = setup(ResolverKind::Pipeline);
            ctx(&admin(), NEAR);
            let _ = c.set_pipeline(SCHEMA, $resolvers);
        }
    };
}

bad_pipeline!(pipeline_rejects_empty, vec![], "a pipeline has 1 to 4 resolvers");
bad_pipeline!(pipeline_rejects_five, vec![r(1), r(2), r(3), r(4), r(5)], "a pipeline has 1 to 4 resolvers");
bad_pipeline!(pipeline_rejects_duplicates, vec![r(1), r(2), r(1)], "pipeline resolvers must be distinct");
bad_pipeline!(pipeline_rejects_itself, vec![r(1), me()], "a pipeline cannot include itself");

#[test]
#[should_panic(expected = "only the schema admin")]
fn set_pipeline_requires_admin() {
    let mut c = setup(ResolverKind::Pipeline);
    ctx(&alice(), NEAR);
    let _ = c.set_pipeline(SCHEMA, vec![r(1)]);
}

#[test]
fn pipeline_accepts_four() {
    let mut c = setup(ResolverKind::Pipeline);
    ctx(&admin(), NEAR);
    let _ = c.set_pipeline(SCHEMA, vec![r(1), r(2), r(3), r(4)]);
    assert_eq!(calls().len(), 5);
}

#[test]
fn pipeline_without_config_approves() {
    let mut c = setup(ResolverKind::Pipeline);
    ctx(&attestations(), 0);
    assert!(value(c.on_attest(attest(&alice()))));
    assert!(value(c.on_revoke(attest(&alice()))));
    c.on_aborted(attest(&alice()));
    c.on_committed(attest(&alice()));
    assert!(get_created_receipts().is_empty());
}

#[test]
fn pipeline_starts_with_the_first_resolver() {
    let mut c = pipeline_setup(vec![r(1), r(2), r(3)]);
    ctx(&attestations(), 0);
    let _ = c.on_attest(attest(&alice()));
    let cs = calls();
    assert_eq!(cs.len(), 2);
    assert_eq!(cs[0].receiver, r(1));
    assert_eq!(cs[0].method, "on_attest");
    assert_eq!(cs[0].args["call"]["attester"], "alice.testnet");
    assert!(cs[0].gas >= Gas::from_tgas(25));
    assert_eq!(cs[1].receiver, me());
    assert_eq!(cs[1].method, "pipeline_step");
    assert_eq!(cs[1].args["index"], 0);
    assert!(cs[1].gas >= Gas::from_tgas(120));
}

#[test]
fn pipeline_step_continues_on_approval() {
    let mut c = pipeline_setup(vec![r(1), r(2), r(3)]);
    callback(vec![ok_json(&true)]);
    match c.pipeline_step(attest(&alice()), vec![r(1), r(2), r(3)], 0) {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(_) => panic!("expected the next step"),
    }
    let cs = calls();
    assert_eq!(cs[0].receiver, r(2));
    assert_eq!(cs[0].method, "on_attest");
    assert_eq!(cs[1].method, "pipeline_step");
    assert_eq!(cs[1].args["index"], 1);
    assert!(cs[1].gas >= Gas::from_tgas(80));
}

#[test]
fn pipeline_last_approval_records_the_run() {
    let mut c = pipeline_setup(vec![r(1), r(2)]);
    callback(vec![ok_json(&true)]);
    assert!(value(c.pipeline_step(attest(&alice()), vec![r(1), r(2)], 1)));
    assert!(get_created_receipts().is_empty());
    // The admin changes the pipeline while the attestation is pending; the commit still goes
    // to the resolvers that approved it.
    callback(vec![ok_json(&true)]);
    assert!(c.pipeline_configured(SCHEMA, vec![r(3)], admin(), U128(NEAR)));
    ctx(&attestations(), 0);
    c.on_committed(attest(&alice()));
    let cs = calls();
    assert_eq!(cs.len(), 2);
    assert_eq!((cs[0].receiver.clone(), cs[0].method.as_str()), (r(1), "on_committed"));
    assert_eq!((cs[1].receiver.clone(), cs[1].method.as_str()), (r(2), "on_committed"));
    // The run is consumed; a later hook falls back to the configured pipeline.
    ctx(&attestations(), 0);
    c.on_aborted(attest(&alice()));
    let cs = calls();
    assert_eq!(cs.len(), 1);
    assert_eq!((cs[0].receiver.clone(), cs[0].method.as_str()), (r(3), "on_aborted"));
}

#[test]
fn pipeline_abort_forwards_to_the_run() {
    let mut c = pipeline_setup(vec![r(1), r(2)]);
    callback(vec![ok_json(&true)]);
    assert!(value(c.pipeline_step(attest(&alice()), vec![r(1), r(2)], 1)));
    ctx(&attestations(), 0);
    c.on_aborted(attest(&alice()));
    let methods: Vec<_> = calls().into_iter().map(|c| (c.receiver, c.method)).collect();
    assert_eq!(methods, vec![(r(1), "on_aborted".to_string()), (r(2), "on_aborted".to_string())]);
}

#[test]
fn pipeline_refusal_aborts_earlier_resolvers() {
    let mut c = pipeline_setup(vec![r(1), r(2), r(3)]);
    callback(vec![ok_json(&false)]);
    assert!(!value(c.pipeline_step(attest(&alice()), vec![r(1), r(2), r(3)], 2)));
    let methods: Vec<_> = calls().into_iter().map(|c| (c.receiver, c.method)).collect();
    assert_eq!(methods, vec![(r(1), "on_aborted".to_string()), (r(2), "on_aborted".to_string())]);
    assert!(get_logs().iter().any(|l| l.contains("r3.testnet refused")));
    // A refused run is not recorded.
    ctx(&attestations(), 0);
    c.on_committed(attest(&alice()));
    assert_eq!(calls().len(), 3);
}

#[test]
fn pipeline_failure_counts_as_refusal() {
    let mut c = pipeline_setup(vec![r(1), r(2)]);
    callback(vec![PromiseResult::Failed]);
    assert!(!value(c.pipeline_step(attest(&alice()), vec![r(1), r(2)], 1)));
    assert_eq!(calls().len(), 1);
    // The first resolver refusing aborts nothing.
    callback(vec![ok_json(&false)]);
    assert!(!value(c.pipeline_step(attest(&alice()), vec![r(1), r(2)], 0)));
    assert!(calls().is_empty());
}

#[test]
fn pipeline_revocation_runs_without_aborts() {
    let mut c = pipeline_setup(vec![r(1), r(2)]);
    let revoke = resolver_call(ResolverOp::Revoke, &alice(), "bob.testnet");
    ctx(&attestations(), 0);
    let _ = c.on_revoke(revoke.clone());
    let cs = calls();
    assert_eq!(cs[0].receiver, r(1));
    assert_eq!(cs[0].method, "on_revoke");
    callback(vec![ok_json(&true)]);
    let _ = c.pipeline_step(revoke.clone(), vec![r(1), r(2)], 0);
    assert_eq!(calls()[0].method, "on_revoke");
    callback(vec![ok_json(&false)]);
    assert!(!value(c.pipeline_step(revoke.clone(), vec![r(1), r(2)], 1)));
    assert!(calls().is_empty());
    callback(vec![ok_json(&true)]);
    assert!(value(c.pipeline_step(revoke.clone(), vec![r(1), r(2)], 1)));
    // Revocations record no run; commits go to the configured pipeline.
    ctx(&attestations(), 0);
    c.on_committed(revoke);
    assert_eq!(calls().len(), 2);
}

#[test]
fn pipeline_schedule_uses_on_revoke() {
    let mut c = pipeline_setup(vec![r(1)]);
    ctx(&attestations(), 0);
    let _ = c.on_revoke(resolver_call(ResolverOp::Schedule, &alice(), "bob.testnet"));
    assert_eq!(calls()[0].method, "on_revoke");
}

#[test]
fn pipeline_view_and_event_on_reconfigure() {
    let mut c = pipeline_setup(vec![r(1), r(2)]);
    assert_eq!(c.get_pipeline(SCHEMA), vec![r(1), r(2)]);
    assert!(c.get_pipeline(OTHER_SCHEMA).is_empty());
    // Shrinking the list frees storage, so the whole deposit comes back.
    callback(vec![ok_json(&true)]);
    assert!(c.pipeline_configured(SCHEMA, vec![r(1)], admin(), U128(9)));
    assert_eq!(transfers(), vec![(admin(), 9)]);
    assert_eq!(c.get_pipeline(SCHEMA), vec![r(1)]);
}

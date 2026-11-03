use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("schemas.attestra.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(deposit)
        .block_timestamp(1_700_000_000 * 1_000_000_000);
    b
}

fn set(predecessor: &str, deposit: NearToken) {
    testing_env!(ctx(predecessor, deposit).build());
}

fn set_with_result(result: PromiseResult) {
    testing_env!(
        ctx("schemas.attestra.testnet", NearToken::from_yoctonear(0)).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn contract() -> Contract {
    set("owner.testnet", NearToken::from_yoctonear(0));
    Contract::new(acc("owner.testnet"), acc("attestations.attestra.testnet"))
}

const DEF: &str = "string name, u8 level, bool verified";

#[test]
fn registers_after_sync() {
    let mut c = contract();
    set("alice.testnet", NearToken::from_millinear(100));
    let _ = c.register_schema(DEF.into(), None, true);
    let uid = schema_uid(DEF, &None, true);
    assert_eq!(c.get_schema(uid).unwrap().status, SchemaStatus::Pending);
    assert_eq!(c.schema_count(), 0);

    set_with_result(PromiseResult::Successful(vec![]));
    assert_eq!(c.on_synced(uid), Some(uid));
    let s = c.get_schema(uid).unwrap();
    assert_eq!(s.status, SchemaStatus::Active);
    assert_eq!(s.authority, acc("alice.testnet"));
    assert_eq!(s.definition, DEF);
    assert_eq!(c.schema_count(), 1);
    assert_eq!(c.list_schemas(None, None).len(), 1);
    assert_eq!(c.compute_schema_uid(DEF.into(), None, true), uid);
}

#[test]
#[should_panic(expected = "already exists")]
fn duplicate_rejected() {
    let mut c = contract();
    set("alice.testnet", NearToken::from_millinear(100));
    let _ = c.register_schema(DEF.into(), None, true);
    set("bob.testnet", NearToken::from_millinear(100));
    let _ = c.register_schema(DEF.into(), None, true);
}

#[test]
#[should_panic(expected = "unknown type")]
fn invalid_definition_rejected() {
    let mut c = contract();
    set("alice.testnet", NearToken::from_millinear(100));
    let _ = c.register_schema("uint256 amount".into(), None, true);
}

#[test]
#[should_panic(expected = "no storage balance")]
fn needs_storage() {
    let mut c = contract();
    set("alice.testnet", NearToken::from_yoctonear(0));
    let _ = c.register_schema(DEF.into(), None, true);
}

#[test]
fn resolver_refusal_rolls_back_and_refunds() {
    let mut c = contract();
    set("alice.testnet", NearToken::from_millinear(100));
    let resolver = Some(acc("whitelist.attestra.testnet"));
    let _ = c.register_schema(DEF.into(), resolver.clone(), true);
    let uid = schema_uid(DEF, &resolver, true);
    let after_register = c.storage_balance_of(acc("alice.testnet")).unwrap();

    set_with_result(PromiseResult::Successful(b"false".to_vec()));
    let out = c.on_resolver_checked(uid);
    assert!(matches!(out, PromiseOrValue::Value(None)));
    assert!(c.get_schema(uid).is_none());
    let after = c.storage_balance_of(acc("alice.testnet")).unwrap();
    // The schema's bytes and the sync deposit are back in the available balance.
    assert!(after.available.0 > after_register.available.0 + SYNC_DEPOSIT.as_yoctonear());
    assert_eq!(after.total.0, 100 * 10u128.pow(21));
}

#[test]
fn resolver_failure_is_a_refusal() {
    let mut c = contract();
    set("alice.testnet", NearToken::from_millinear(100));
    let resolver = Some(acc("whitelist.attestra.testnet"));
    let _ = c.register_schema(DEF.into(), resolver.clone(), false);
    let uid = schema_uid(DEF, &resolver, false);
    set_with_result(PromiseResult::Failed);
    let _ = c.on_resolver_checked(uid);
    assert!(c.get_schema(uid).is_none());
}

#[test]
fn sync_failure_rolls_back() {
    let mut c = contract();
    set("alice.testnet", NearToken::from_millinear(100));
    let _ = c.register_schema(DEF.into(), None, true);
    let uid = schema_uid(DEF, &None, true);
    set_with_result(PromiseResult::Failed);
    assert_eq!(c.on_synced(uid), None);
    assert!(c.get_schema(uid).is_none());
    let b = c.storage_balance_of(acc("alice.testnet")).unwrap();
    assert_eq!(b.total.0, 100 * 10u128.pow(21));
}

#[test]
fn blob_schema_has_the_inline_uid() {
    let mut c = contract();
    set("alice.testnet", NearToken::from_millinear(200));
    let big: String = (0..200).map(|i| format!("u64 field_{i}")).collect::<Vec<_>>().join(", ");
    let hash = c.store_blob(big.clone());
    assert_eq!(hash, Uid::sha256(big.as_bytes()));
    assert_eq!(c.get_blob(hash).unwrap(), big);
    set("alice.testnet", NearToken::from_yoctonear(0));
    let _ = c.register_schema_from_blob(hash, None, true);
    let uid = schema_uid(&big, &None, true);
    let view = c.get_schema(uid).unwrap();
    assert_eq!(view.blob_hash, Some(hash));
    assert_eq!(view.definition, big);
}

#[test]
#[should_panic(expected = "definition too long")]
fn inline_limit() {
    let mut c = contract();
    set("alice.testnet", NearToken::from_near(1));
    let big: String = (0..2000).map(|i| format!("u64 f{i}")).collect::<Vec<_>>().join(", ");
    let _ = c.register_schema(big, None, true);
}

#[test]
fn storage_deposit_and_withdraw() {
    let mut c = contract();
    set("relayer.testnet", NearToken::from_millinear(50));
    let b = c.storage_deposit(Some(acc("issuer.testnet")), None);
    assert_eq!(b.total.0, 50 * 10u128.pow(21));
    assert!(c.storage_balance_of(acc("relayer.testnet")).is_none());
    set("issuer.testnet", NearToken::from_yoctonear(1));
    let after = c.storage_withdraw(Some(U128(10u128.pow(21))));
    assert_eq!(after.total.0, 49 * 10u128.pow(21));
    assert!(c.storage_unregister(None));
    assert!(c.storage_balance_of(acc("issuer.testnet")).is_none());
}

#[test]
#[should_panic(expected = "registry cannot be a resolver")]
fn self_resolver_rejected() {
    let mut c = contract();
    set("alice.testnet", NearToken::from_millinear(100));
    let _ = c.register_schema(DEF.into(), Some(acc("schemas.attestra.testnet")), true);
}

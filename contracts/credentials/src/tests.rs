use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const ATTESTATION: Uid = Uid([7; 32]);
const SCHEMA: Uid = Uid([3; 32]);

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn attestations() -> AccountId {
    acc("attestations.testnet")
}
fn me() -> AccountId {
    acc("credentials.testnet")
}
fn alice() -> AccountId {
    acc("alice.testnet")
}
fn bob() -> AccountId {
    acc("bob.testnet")
}
fn carol() -> AccountId {
    acc("carol.testnet")
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

fn setup() -> Contract {
    ctx(&owner(), 0);
    Contract::new(owner(), attestations())
}

/// The JSON `get_attestation` returns: alice attests about bob.
fn view_json(uid: &Uid, subject: &str, status: &str, expiration_time: u64) -> Value {
    json!({
        "uid": uid, "schema_uid": SCHEMA, "attester": "alice.testnet", "subject": subject,
        "data": "AQID", "created_at": 1_700_000_000u64, "expiration_time": expiration_time,
        "revoked": false, "revocation_time": 0, "revoke_at": 0, "nonce": 0, "ref_uid": null,
        "status": status,
    })
}

fn answer(view: &Value) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(view).unwrap())
}

/// Runs `mint_checked` with `view` as the attestations contract's answer.
fn mint_with(c: &mut Contract, uid: Uid, minter: &AccountId, deposit: u128, view: Value) -> Option<Token> {
    callback(vec![answer(&view)]);
    c.mint_checked(uid, minter.clone(), U128(deposit))
}

fn mint_ok(c: &mut Contract, uid: Uid, subject: &str) -> Token {
    mint_with(c, uid, &alice(), NEAR, view_json(&uid, subject, "active", 0)).expect("minted")
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

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn init_metadata() {
    let c = setup();
    let m = c.nft_metadata();
    assert_eq!(m.spec, "nft-1.0.0");
    assert_eq!(m.name, "Attestra Credentials");
    assert_eq!(m.symbol, "ATTEST");
    assert_eq!(c.nft_total_supply(), U128(0));
    assert!(c.nft_tokens(None, None).is_empty());
    assert_eq!(c.credential_for_attestation(ATTESTATION), None);
}

#[test]
fn mint_reads_the_attestation() {
    let mut c = setup();
    ctx(&bob(), NEAR);
    let _ = c.mint(ATTESTATION);
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, attestations());
    let MockAction::FunctionCallWeight { method_name, args, .. } = &receipts[0].actions[0] else {
        panic!("expected a function call")
    };
    assert_eq!(method_name, b"get_attestation");
    let args: Value = serde_json::from_slice(args).unwrap();
    assert_eq!(args, json!({ "uid": ATTESTATION.to_hex() }));
    assert_eq!(receipts[1].receiver_id, me());
    assert_eq!(receipts[1].receipt_indices, vec![0]);
    let MockAction::FunctionCallWeight { method_name, args, .. } = &receipts[1].actions[0] else {
        panic!("expected a function call")
    };
    assert_eq!(method_name, b"mint_checked");
    let args: Value = serde_json::from_slice(args).unwrap();
    assert_eq!(
        args,
        json!({ "attestation_uid": ATTESTATION.to_hex(), "minter": "bob.testnet", "deposit": NEAR.to_string() })
    );
}

#[test]
#[should_panic(expected = "attach a deposit")]
fn mint_requires_a_deposit() {
    let mut c = setup();
    ctx(&bob(), 0);
    let _ = c.mint(ATTESTATION);
}

#[test]
#[should_panic(expected = "a credential already exists")]
fn mint_rejects_an_existing_credential_upfront() {
    let mut c = setup();
    mint_ok(&mut c, ATTESTATION, "bob.testnet");
    ctx(&bob(), NEAR);
    let _ = c.mint(ATTESTATION);
}

#[test]
fn mint_by_the_attester() {
    let mut c = setup();
    callback(vec![answer(&view_json(&ATTESTATION, "bob.testnet", "active", 0))]);
    let before = env::storage_usage();
    let token = c.mint_checked(ATTESTATION, alice(), U128(NEAR)).unwrap();
    let cost = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
    assert!(cost > 0);
    assert_eq!(token.token_id, ATTESTATION.to_hex());
    assert_eq!(token.owner_id, bob());
    assert_eq!(token.approved_account_ids, None);
    assert_eq!(transfers(), vec![(alice(), NEAR - cost)]);

    let m = token.metadata.clone().unwrap();
    assert_eq!(m.title.as_deref(), Some("Attestra credential"));
    let description = m.description.unwrap();
    assert!(description.contains(&SCHEMA.to_hex()));
    assert!(description.contains("alice.testnet"));
    assert_eq!(m.issued_at.as_deref(), Some("1700000000000"));
    assert_eq!(m.expires_at, None);
    let extra: Value = serde_json::from_str(&m.extra.unwrap()).unwrap();
    assert_eq!(
        extra,
        json!({ "schema_uid": SCHEMA.to_hex(), "attester": "alice.testnet", "attestation_uid": ATTESTATION.to_hex() })
    );

    let e = events();
    assert_eq!(e.len(), 2);
    assert_eq!(e[0]["standard"], "nep171");
    assert_eq!(e[0]["event"], "nft_mint");
    assert_eq!(e[0]["data"][0]["owner_id"], "bob.testnet");
    assert_eq!(e[0]["data"][0]["token_ids"][0], ATTESTATION.to_hex());
    assert_eq!(e[1]["standard"], "attestra");
    assert_eq!(e[1]["event"], "credential_minted");
    assert_eq!(e[1]["data"][0]["minter"], "alice.testnet");
    assert_eq!(e[1]["data"][0]["owner_id"], "bob.testnet");
    assert_eq!(e[1]["data"][0]["schema_uid"], SCHEMA.to_hex());

    assert_eq!(c.nft_token(ATTESTATION.to_hex()), Some(token.clone()));
    assert_eq!(c.credential_for_attestation(ATTESTATION), Some(token.clone()));
    assert_eq!(c.nft_total_supply(), U128(1));
    assert_eq!(c.nft_supply_for_owner(bob()), U128(1));
    assert_eq!(c.nft_supply_for_owner(alice()), U128(0));
    assert_eq!(c.nft_tokens_for_owner(bob(), None, None), vec![token.clone()]);
    assert_eq!(c.nft_tokens(None, None), vec![token]);
}

#[test]
fn mint_by_the_subject_with_expiry() {
    let mut c = setup();
    let token = mint_with(
        &mut c,
        ATTESTATION,
        &bob(),
        NEAR,
        view_json(&ATTESTATION, "bob.testnet", "active", 1_800_000_000),
    )
    .unwrap();
    let m = token.metadata.unwrap();
    assert_eq!(m.expires_at.as_deref(), Some("1800000000000"));
    assert_eq!(transfers()[0].0, bob());
}

#[test]
fn mint_with_the_exact_deposit_refunds_nothing() {
    let mut c = setup();
    callback(vec![answer(&view_json(&ATTESTATION, "bob.testnet", "active", 0))]);
    let before = env::storage_usage();
    c.mint_checked(ATTESTATION, alice(), U128(NEAR)).unwrap();
    let cost = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
    let bytes = env::storage_usage() - before;
    // Burning frees exactly what the mint wrote, so the same mint costs the same again.
    ctx(&attestations(), 0);
    let before_burn = env::storage_usage();
    c.on_attestation_revoked(ATTESTATION);
    assert_eq!(before_burn - env::storage_usage(), bytes);
    let view = view_json(&ATTESTATION, "bob.testnet", "active", 0);
    assert!(mint_with(&mut c, ATTESTATION, &alice(), cost, view).is_some());
    assert!(transfers().is_empty());
    // One yoctoNEAR less is refused.
    ctx(&attestations(), 0);
    c.on_attestation_revoked(ATTESTATION);
    let view = view_json(&ATTESTATION, "bob.testnet", "active", 0);
    assert!(mint_with(&mut c, ATTESTATION, &alice(), cost - 1, view).is_none());
    assert_eq!(transfers(), vec![(alice(), cost - 1)]);
}

fn assert_refused(c: &Contract, minter: &AccountId, deposit: u128, reason: &str) {
    assert_eq!(transfers(), vec![(minter.clone(), deposit)]);
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains(reason)), "no log with {reason:?} in {logs:?}");
    assert!(events().is_empty());
    assert_eq!(c.nft_total_supply(), U128(0));
    assert_eq!(c.credential_for_attestation(ATTESTATION), None);
}

#[test]
fn mint_refused_unless_active() {
    for status in ["pending", "revoking", "revoked", "expired"] {
        let mut c = setup();
        let view = view_json(&ATTESTATION, "bob.testnet", status, 0);
        assert!(mint_with(&mut c, ATTESTATION, &alice(), 500, view).is_none());
        assert_refused(&c, &alice(), 500, &format!("the attestation is {status}"));
    }
}

#[test]
fn mint_refused_for_other_callers() {
    let mut c = setup();
    let view = view_json(&ATTESTATION, "bob.testnet", "active", 0);
    assert!(mint_with(&mut c, ATTESTATION, &carol(), 500, view).is_none());
    assert_refused(&c, &carol(), 500, "neither the attester nor the subject");
}

#[test]
fn mint_refused_for_foreign_subjects() {
    let mut c = setup();
    let subject = "eip155:1:0xab5801a7d398351b8be11c439e05c5b3259aec9b";
    let view = view_json(&ATTESTATION, subject, "active", 0);
    assert!(mint_with(&mut c, ATTESTATION, &alice(), 500, view).is_none());
    assert_refused(&c, &alice(), 500, "is not a NEAR account");
}

#[test]
fn mint_refused_when_the_attestation_is_missing_or_unreadable() {
    let mut c = setup();
    callback(vec![PromiseResult::Successful(b"null".to_vec())]);
    assert!(c.mint_checked(ATTESTATION, alice(), U128(500)).is_none());
    assert_refused(&c, &alice(), 500, "does not exist");

    callback(vec![PromiseResult::Failed]);
    assert!(c.mint_checked(ATTESTATION, alice(), U128(500)).is_none());
    assert_refused(&c, &alice(), 500, "could not be read");

    callback(vec![PromiseResult::Successful(b"{\"uid\":1}".to_vec())]);
    assert!(c.mint_checked(ATTESTATION, alice(), U128(500)).is_none());
    assert_refused(&c, &alice(), 500, "could not be parsed");

    callback(vec![]);
    assert!(c.mint_checked(ATTESTATION, alice(), U128(500)).is_none());
    assert_refused(&c, &alice(), 500, "expected one promise result");
}

#[test]
fn mint_refused_for_another_attestation() {
    let mut c = setup();
    let view = view_json(&Uid([8; 32]), "bob.testnet", "active", 0);
    assert!(mint_with(&mut c, ATTESTATION, &alice(), 500, view).is_none());
    assert_refused(&c, &alice(), 500, "another attestation");
}

#[test]
fn mint_refused_twice() {
    let mut c = setup();
    mint_ok(&mut c, ATTESTATION, "bob.testnet");
    let view = view_json(&ATTESTATION, "bob.testnet", "active", 0);
    assert!(mint_with(&mut c, ATTESTATION, &bob(), 500, view).is_none());
    assert_eq!(transfers(), vec![(bob(), 500)]);
    assert!(get_logs().iter().any(|l| l.contains("already exists")));
    assert_eq!(c.nft_total_supply(), U128(1));
}

#[test]
fn mint_refused_when_the_deposit_is_short() {
    let mut c = setup();
    let usage = {
        callback(vec![]);
        env::storage_usage()
    };
    let view = view_json(&ATTESTATION, "bob.testnet", "active", 0);
    assert!(mint_with(&mut c, ATTESTATION, &alice(), 1, view).is_none());
    assert_refused(&c, &alice(), 1, "attach at least");
    // The partial mint left nothing behind.
    assert_eq!(env::storage_usage(), usage);
    assert!(c.nft_tokens_for_owner(bob(), None, None).is_empty());
    assert_eq!(c.nft_supply_for_owner(bob()), U128(0));
}

#[test]
fn revocation_burns_the_credential() {
    let mut c = setup();
    mint_ok(&mut c, ATTESTATION, "bob.testnet");
    let other = Uid([8; 32]);
    let kept = mint_ok(&mut c, other, "bob.testnet");
    assert_eq!(c.nft_supply_for_owner(bob()), U128(2));

    ctx(&attestations(), 0);
    c.on_attestation_revoked(ATTESTATION);
    assert_eq!(c.credential_for_attestation(ATTESTATION), None);
    assert_eq!(c.nft_token(ATTESTATION.to_hex()), None);
    assert_eq!(c.nft_total_supply(), U128(1));
    assert_eq!(c.nft_supply_for_owner(bob()), U128(1));
    assert_eq!(c.nft_tokens_for_owner(bob(), None, None), vec![kept]);
    let e = events();
    assert_eq!(e.len(), 2);
    assert_eq!(e[0]["standard"], "nep171");
    assert_eq!(e[0]["event"], "nft_burn");
    assert_eq!(e[0]["data"][0]["owner_id"], "bob.testnet");
    assert_eq!(e[1]["event"], "credential_burned");
    assert_eq!(e[1]["data"][0]["attestation_uid"], ATTESTATION.to_hex());
    // The freed storage stays with the contract.
    assert!(transfers().is_empty());

    // Burning the last one clears the owner's index.
    ctx(&attestations(), 0);
    c.on_attestation_revoked(other);
    assert_eq!(c.nft_total_supply(), U128(0));
    assert_eq!(c.nft_supply_for_owner(bob()), U128(0));
    assert!(c.nft_tokens_for_owner(bob(), None, None).is_empty());
}

#[test]
fn revocation_without_a_credential_is_a_no_op() {
    let mut c = setup();
    ctx(&attestations(), 0);
    c.on_attestation_revoked(ATTESTATION);
    c.on_attestation_revoked(ATTESTATION);
    assert!(events().is_empty());
}

#[test]
fn burned_credential_can_be_minted_again_for_an_active_attestation() {
    let mut c = setup();
    mint_ok(&mut c, ATTESTATION, "bob.testnet");
    ctx(&attestations(), 0);
    c.on_attestation_revoked(ATTESTATION);
    // Mint checks the attestation again, so a revoked one is refused.
    let view = view_json(&ATTESTATION, "bob.testnet", "revoked", 0);
    assert!(mint_with(&mut c, ATTESTATION, &bob(), 9, view).is_none());
    assert_eq!(transfers(), vec![(bob(), 9)]);
}

#[test]
#[should_panic(expected = "only the attestations contract can burn credentials")]
fn revocation_requires_the_attestations_contract() {
    let mut c = setup();
    mint_ok(&mut c, ATTESTATION, "bob.testnet");
    ctx(&bob(), 0);
    c.on_attestation_revoked(ATTESTATION);
}

#[test]
fn enumeration_pages() {
    let mut c = setup();
    let ids: Vec<Uid> = (10..14).map(|n| Uid([n; 32])).collect();
    for id in &ids {
        mint_ok(&mut c, *id, "bob.testnet");
    }
    mint_ok(&mut c, Uid([20; 32]), "carol.testnet");
    assert_eq!(c.nft_total_supply(), U128(5));
    assert_eq!(c.nft_tokens(Some(U128(1)), Some(2)).len(), 2);
    assert_eq!(c.nft_tokens_for_owner(bob(), Some(U128(3)), Some(10)).len(), 1);
    assert_eq!(c.nft_tokens_for_owner(carol(), None, None)[0].token_id, Uid([20; 32]).to_hex());
    assert_eq!(c.nft_supply_for_owner(carol()), U128(1));
}

#[test]
fn nothing_is_approved() {
    let mut c = setup();
    mint_ok(&mut c, ATTESTATION, "bob.testnet");
    assert!(!c.nft_is_approved(ATTESTATION.to_hex(), alice(), None));
    assert!(!c.nft_is_approved(ATTESTATION.to_hex(), bob(), Some(1)));
}

macro_rules! non_transferable {
    ($name:ident, |$c:ident| $body:expr) => {
        #[test]
        #[should_panic(expected = "credentials are non-transferable")]
        fn $name() {
            let mut $c = setup();
            mint_ok(&mut $c, ATTESTATION, "bob.testnet");
            ctx(&bob(), 1);
            let _ = $body;
        }
    };
}

non_transferable!(transfer_is_disabled, |c| c.nft_transfer(carol(), ATTESTATION.to_hex(), None, None));
non_transferable!(transfer_call_is_disabled, |c| c.nft_transfer_call(
    carol(),
    ATTESTATION.to_hex(),
    None,
    None,
    String::new()
));
non_transferable!(approve_is_disabled, |c| c.nft_approve(ATTESTATION.to_hex(), carol(), None));
non_transferable!(revoke_is_disabled, |c| c.nft_revoke(ATTESTATION.to_hex(), carol()));
non_transferable!(revoke_all_is_disabled, |c| c.nft_revoke_all(ATTESTATION.to_hex()));

#[test]
fn attestation_view_ignores_unknown_fields() {
    let view: AttestationView =
        serde_json::from_value(view_json(&ATTESTATION, "bob.testnet", "active", 5)).unwrap();
    assert_eq!(view.uid, ATTESTATION);
    assert_eq!(view.schema_uid, SCHEMA);
    assert_eq!(view.attester, alice());
    assert_eq!(view.expiration_time, 5);
    assert_eq!(view.status, "active");
}

/// A revocation that reaches this contract after `mint` read the attestation as active, but
/// before `mint_checked` ran, must still stop the mint: otherwise the subject keeps a credential
/// for a revoked attestation that nothing will ever burn.
#[test]
fn revocation_during_a_mint_in_flight_stops_the_mint() {
    let mut c = setup();
    ctx(&bob(), NEAR);
    let _ = c.mint(ATTESTATION);
    // The attestations contract answered `active`, then the attester revoked and the burn
    // arrived first.
    ctx(&attestations(), 0);
    c.on_attestation_revoked(ATTESTATION);
    let view = view_json(&ATTESTATION, "bob.testnet", "active", 0);
    assert!(mint_with(&mut c, ATTESTATION, &bob(), NEAR, view).is_none());
    assert_eq!(c.credential_for_attestation(ATTESTATION), None);
    assert_eq!(transfers(), vec![(bob(), NEAR)]);
}

/// Concurrent mints of one attestation are each checked; the in-flight record clears once
/// every callback ran.
#[test]
fn concurrent_mints_clear_their_in_flight_record() {
    let mut c = setup();
    ctx(&bob(), NEAR);
    let _ = c.mint(ATTESTATION);
    ctx(&alice(), NEAR);
    let _ = c.mint(ATTESTATION);
    assert!(mint_with(
        &mut c,
        ATTESTATION,
        &bob(),
        NEAR,
        view_json(&ATTESTATION, "bob.testnet", "active", 0)
    )
    .is_some());
    assert!(mint_with(
        &mut c,
        ATTESTATION,
        &alice(),
        NEAR,
        view_json(&ATTESTATION, "bob.testnet", "active", 0)
    )
    .is_none());
    assert!(c.minting.get(&ATTESTATION).is_none());
    // A revocation after the mint burns as usual.
    ctx(&attestations(), 0);
    c.on_attestation_revoked(ATTESTATION);
    assert_eq!(c.credential_for_attestation(ATTESTATION), None);
}

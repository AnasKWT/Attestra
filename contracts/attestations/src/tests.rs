use super::*;
use attestra_common::nep413;
use attestra_common::uid::attestation_uid;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseOrValue, PromiseResult, PublicKey, RuntimeFeesConfig};

const T0: u64 = 1_700_000_000;
const SELF: &str = "attestations.attestra.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: NearToken, at: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(SELF))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(deposit)
        .block_timestamp(at * 1_000_000_000);
    b
}

fn set(predecessor: &str, deposit: NearToken) {
    testing_env!(ctx(predecessor, deposit, T0).build());
}

fn set_at(predecessor: &str, at: u64) {
    testing_env!(ctx(predecessor, NearToken::from_yoctonear(0), at).build());
}

fn set_result(result: PromiseResult) {
    testing_env!(
        ctx(SELF, NearToken::from_yoctonear(0), T0).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn schema(n: u8) -> Uid {
    Uid([n; 32])
}

/// A contract with schema 1 (no resolver, revocable), 2 (resolver, revocable), 3 (not revocable).
fn setup() -> Contract {
    set("owner.testnet", NearToken::from_yoctonear(0));
    let mut c = Contract::new(acc("owner.testnet"), acc("gov.testnet"), acc("schemas.attestra.testnet"));
    set("schemas.attestra.testnet", NearToken::from_millinear(3));
    c.sync_schema(schema(1), SchemaInfo { authority: acc("alice.testnet"), resolver: None, revocable: true });
    c.sync_schema(
        schema(2),
        SchemaInfo {
            authority: acc("alice.testnet"),
            resolver: Some(acc("whitelist.attestra.testnet")),
            revocable: true,
        },
    );
    c.sync_schema(
        schema(3),
        SchemaInfo { authority: acc("alice.testnet"), resolver: None, revocable: false },
    );
    c
}

fn value(o: PromiseOrValue<Outcome>) -> Outcome {
    match o {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

fn attest(c: &mut Contract, who: &str, schema_uid: Uid, subject: &str) -> Uid {
    set(who, NearToken::from_millinear(50));
    let o = c.attest(schema_uid, subject.into(), Base64VecU8(vec![1, 2, 3]), None, None);
    match o {
        PromiseOrValue::Value(v) => v.uid,
        PromiseOrValue::Promise(_) => {
            let n = c.get_nonce(acc(who)) - 1;
            attestation_uid(&schema_uid, subject, &acc(who), &[1, 2, 3], n)
        }
    }
}

#[test]
#[should_panic(expected = "only the schemas contract")]
fn sync_only_from_schemas() {
    let mut c = setup();
    set("mallory.testnet", NearToken::from_millinear(3));
    c.sync_schema(
        schema(9),
        SchemaInfo { authority: acc("mallory.testnet"), resolver: None, revocable: true },
    );
}

#[test]
fn attest_without_resolver() {
    let mut c = setup();
    let uid = attest(&mut c, "alice.testnet", schema(1), "bob.testnet");
    assert_eq!(uid, attestation_uid(&schema(1), "bob.testnet", &acc("alice.testnet"), &[1, 2, 3], 0));
    let v = c.get_attestation(uid).unwrap();
    assert_eq!(v.status, "active");
    assert_eq!(v.attester, acc("alice.testnet"));
    assert_eq!(v.created_at, T0);
    assert_eq!(c.get_nonce(acc("alice.testnet")), 1);
    assert_eq!(c.attestation_count(), 1);
    assert!(c.is_valid(uid));
    let second = attest(&mut c, "alice.testnet", schema(1), "bob.testnet");
    assert_ne!(uid, second);
}

#[test]
fn foreign_chain_subject() {
    let mut c = setup();
    let uid =
        attest(&mut c, "alice.testnet", schema(1), "eip155:1:0xab5801a7d398351b8be11c439e05c5b3259aec9b");
    assert_eq!(
        c.get_attestation(uid).unwrap().subject,
        "eip155:1:0xab5801a7d398351b8be11c439e05c5b3259aec9b"
    );
}

#[test]
#[should_panic(expected = "subject must be")]
fn bad_subject() {
    let mut c = setup();
    attest(&mut c, "alice.testnet", schema(1), "Not A Subject");
}

#[test]
#[should_panic(expected = "unknown schema")]
fn unknown_schema() {
    let mut c = setup();
    attest(&mut c, "alice.testnet", schema(9), "bob.testnet");
}

#[test]
#[should_panic(expected = "no storage balance")]
fn attest_needs_storage() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_yoctonear(0));
    let _ = c.attest(schema(1), "bob.testnet".into(), Base64VecU8(vec![]), None, None);
}

#[test]
fn expiry_edges() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_millinear(50));
    let uid = value(c.attest(schema(1), "bob.testnet".into(), Base64VecU8(vec![]), Some(T0 + 100), None)).uid;
    set_at("x.testnet", T0 + 100);
    assert_eq!(c.get_attestation(uid).unwrap().status, "active");
    set_at("x.testnet", T0 + 101);
    assert_eq!(c.get_attestation(uid).unwrap().status, "expired");
    assert!(!c.is_valid(uid));
}

#[test]
#[should_panic(expected = "expiration_time must be in the future")]
fn past_expiry_rejected() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_millinear(50));
    let _ = c.attest(schema(1), "bob.testnet".into(), Base64VecU8(vec![]), Some(T0), None);
}

#[test]
fn resolver_approves_and_rejects() {
    let mut c = setup();
    let uid = attest(&mut c, "alice.testnet", schema(2), "bob.testnet");
    assert_eq!(c.get_attestation(uid).unwrap().status, "pending");
    assert_eq!(c.attestation_count(), 0);
    set_result(PromiseResult::Successful(b"true".to_vec()));
    assert_eq!(c.on_resolver_verdict(0).status, "created");
    assert_eq!(c.get_attestation(uid).unwrap().status, "active");
    assert_eq!(c.attestation_count(), 1);

    let before = c.storage_balance_of(acc("alice.testnet")).unwrap();
    let uid2 = attest(&mut c, "alice.testnet", schema(2), "carol.testnet");
    set_result(PromiseResult::Successful(b"false".to_vec()));
    assert_eq!(c.on_resolver_verdict(1).status, "rejected");
    assert!(c.get_attestation(uid2).is_none());
    let after = c.storage_balance_of(acc("alice.testnet")).unwrap();
    // The rejected record's bytes are available again (plus the second deposit).
    assert_eq!(after.total.0, before.total.0 + 50 * 10u128.pow(21));

    let uid3 = attest(&mut c, "alice.testnet", schema(2), "dave.testnet");
    set_result(PromiseResult::Failed);
    assert_eq!(c.on_resolver_verdict(2).status, "rejected");
    assert!(c.get_attestation(uid3).is_none());
}

#[test]
fn revoke_rules() {
    let mut c = setup();
    let uid = attest(&mut c, "alice.testnet", schema(1), "bob.testnet");
    set("alice.testnet", NearToken::from_yoctonear(0));
    assert_eq!(value(c.revoke(uid)).status, "revoked");
    let v = c.get_attestation(uid).unwrap();
    assert!(v.revoked);
    assert_eq!(v.status, "revoked");
    assert_eq!(v.revocation_time, T0);
}

#[test]
#[should_panic(expected = "only the attester can revoke")]
fn revoke_by_stranger() {
    let mut c = setup();
    let uid = attest(&mut c, "alice.testnet", schema(1), "bob.testnet");
    set("bob.testnet", NearToken::from_yoctonear(0));
    let _ = c.revoke(uid);
}

#[test]
#[should_panic(expected = "already revoked")]
fn revoke_twice() {
    let mut c = setup();
    let uid = attest(&mut c, "alice.testnet", schema(1), "bob.testnet");
    set("alice.testnet", NearToken::from_yoctonear(0));
    let _ = c.revoke(uid);
    let _ = c.revoke(uid);
}

#[test]
#[should_panic(expected = "not revocable")]
fn revoke_irrevocable() {
    let mut c = setup();
    let uid = attest(&mut c, "alice.testnet", schema(3), "bob.testnet");
    set("alice.testnet", NearToken::from_yoctonear(0));
    let _ = c.revoke(uid);
}

#[test]
fn resolver_can_refuse_a_revocation() {
    let mut c = setup();
    let uid = attest(&mut c, "alice.testnet", schema(2), "bob.testnet");
    set_result(PromiseResult::Successful(b"true".to_vec()));
    c.on_resolver_verdict(0);
    set("alice.testnet", NearToken::from_yoctonear(0));
    assert!(matches!(c.revoke(uid), PromiseOrValue::Promise(_)));
    assert_eq!(c.get_attestation(uid).unwrap().status, "revoking");
    set_result(PromiseResult::Successful(b"false".to_vec()));
    assert_eq!(c.on_resolver_verdict(1).status, "refused");
    assert_eq!(c.get_attestation(uid).unwrap().status, "active");
    set("alice.testnet", NearToken::from_yoctonear(0));
    let _ = c.revoke(uid);
    set_result(PromiseResult::Successful(b"true".to_vec()));
    assert_eq!(c.on_resolver_verdict(2).status, "revoked");
}

#[test]
fn scheduled_revocation() {
    let mut c = setup();
    let uid = attest(&mut c, "alice.testnet", schema(1), "bob.testnet");
    set("alice.testnet", NearToken::from_yoctonear(0));
    assert_eq!(value(c.schedule_revocation(uid, T0 + 60)).status, "scheduled");
    set_at("x.testnet", T0 + 59);
    assert_eq!(c.get_attestation(uid).unwrap().status, "active");
    set_at("keeper.testnet", T0 + 60);
    let v = c.get_attestation(uid).unwrap();
    assert_eq!(v.status, "revoked");
    assert!(v.revoked);
    assert_eq!(v.revocation_time, T0 + 60);
    assert_eq!(c.finalize_revocation(uid).status, "revoked");
}

#[test]
#[should_panic(expected = "no revocation is due")]
fn finalize_too_early() {
    let mut c = setup();
    let uid = attest(&mut c, "alice.testnet", schema(1), "bob.testnet");
    set("alice.testnet", NearToken::from_yoctonear(0));
    let _ = c.schedule_revocation(uid, T0 + 60);
    set_at("keeper.testnet", T0 + 30);
    c.finalize_revocation(uid);
}

#[test]
fn delegation_scope_and_limits() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_millinear(100));
    c.add_delegate(
        acc("agent.testnet"),
        Some(DelegateScope {
            schemas: Some(vec![schema(1)]),
            expires_at: Some(T0 + 1000),
            max_uses: Some(2),
            can_revoke: Some(true),
            label: Some("support agent".into()),
        }),
    );
    assert!(c.is_delegate(acc("alice.testnet"), acc("agent.testnet")));
    set("agent.testnet", NearToken::from_yoctonear(0));
    let o = value(c.attest_on_behalf(
        acc("alice.testnet"),
        schema(1),
        "bob.testnet".into(),
        Base64VecU8(vec![]),
        None,
        None,
    ));
    let a = c.get_attestation(o.uid).unwrap();
    assert_eq!(a.attester, acc("alice.testnet"));
    assert_eq!(value(c.revoke_on_behalf(o.uid)).status, "revoked");
    let d = c.get_delegate(acc("alice.testnet"), acc("agent.testnet")).unwrap();
    assert_eq!(d.uses, 2);
    assert!(!d.active);
    assert_eq!(c.get_delegates(acc("alice.testnet")).len(), 1);
    assert_eq!(c.get_authority(acc("alice.testnet")).map(|a| a.delegate_count), None);
}

#[test]
#[should_panic(expected = "outside the delegation's scope")]
fn delegation_out_of_scope() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_millinear(100));
    c.add_delegate(
        acc("agent.testnet"),
        Some(DelegateScope { schemas: Some(vec![schema(1)]), ..Default::default() }),
    );
    set("agent.testnet", NearToken::from_yoctonear(0));
    let _ = c.attest_on_behalf(
        acc("alice.testnet"),
        schema(3),
        "bob.testnet".into(),
        Base64VecU8(vec![]),
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "the delegation expired")]
fn delegation_expired() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_millinear(100));
    c.add_delegate(
        acc("agent.testnet"),
        Some(DelegateScope { expires_at: Some(T0 + 10), ..Default::default() }),
    );
    testing_env!(ctx("agent.testnet", NearToken::from_yoctonear(0), T0 + 10).build());
    let _ = c.attest_on_behalf(
        acc("alice.testnet"),
        schema(1),
        "bob.testnet".into(),
        Base64VecU8(vec![]),
        None,
        None,
    );
}

#[test]
#[should_panic(expected = "does not allow revoking")]
fn delegation_without_revoke() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_millinear(100));
    c.add_delegate(acc("agent.testnet"), None);
    set("agent.testnet", NearToken::from_yoctonear(0));
    let o = value(c.attest_on_behalf(
        acc("alice.testnet"),
        schema(1),
        "bob.testnet".into(),
        Base64VecU8(vec![]),
        None,
        None,
    ));
    let _ = c.revoke_on_behalf(o.uid);
}

#[test]
#[should_panic(expected = "not a delegate")]
fn removed_delegate() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_millinear(100));
    c.add_delegate(acc("agent.testnet"), None);
    c.remove_delegate(acc("agent.testnet"));
    assert!(c.get_delegates(acc("alice.testnet")).is_empty());
    set("agent.testnet", NearToken::from_yoctonear(0));
    let _ = c.attest_on_behalf(
        acc("alice.testnet"),
        schema(1),
        "bob.testnet".into(),
        Base64VecU8(vec![]),
        None,
        None,
    );
}

fn key(seed: u8) -> (SigningKey, PublicKey) {
    let sk = SigningKey::from_bytes(&[seed; 32]);
    let mut bytes = vec![0u8];
    bytes.extend(sk.verifying_key().to_bytes());
    let pk = PublicKey::try_from(bytes).unwrap();
    (sk, pk)
}

fn signed(sk: &SigningKey, pk: &PublicKey, message: &str, nonce: [u8; 32], recipient: &str) -> SignedRequest {
    let digest = nep413::hash(message, nonce, recipient, None);
    let sig = sk.sign(&digest);
    SignedRequest {
        message: message.into(),
        nonce: Base64VecU8(nonce.to_vec()),
        public_key: pk.clone(),
        signature: Base64VecU8(sig.to_bytes().to_vec()),
        callback_url: None,
    }
}

fn attest_message(attester: &str, deadline: u64) -> String {
    format!(
        "{{\"action\":\"attest\",\"attester\":\"{attester}\",\"schema_uid\":\"{}\",\"subject\":\"bob.testnet\",\"data\":\"AQID\",\"deadline\":{deadline}}}",
        schema(1)
    )
}

#[test]
fn signed_attest_and_revoke() {
    let mut c = setup();
    let (sk, pk) = key(7);
    set("alice.testnet", NearToken::from_millinear(100));
    c.add_signer_key(pk.clone());
    assert_eq!(c.get_signer_keys(acc("alice.testnet")).len(), 1);

    set("relayer.testnet", NearToken::from_yoctonear(0));
    let req = signed(&sk, &pk, &attest_message("alice.testnet", T0 + 60), [1; 32], SELF);
    let o = value(c.submit_signed(req));
    let a = c.get_attestation(o.uid).unwrap();
    assert_eq!(a.attester, acc("alice.testnet"));
    assert_eq!(a.data.0, vec![1, 2, 3]);

    let msg = format!(
        "{{\"action\":\"revoke\",\"attester\":\"alice.testnet\",\"uid\":\"{}\",\"deadline\":{}}}",
        o.uid,
        T0 + 60
    );
    let o2 = value(c.submit_signed(signed(&sk, &pk, &msg, [2; 32], SELF)));
    assert_eq!(o2.status, "revoked");
}

#[test]
#[should_panic(expected = "already used")]
fn signed_replay() {
    let mut c = setup();
    let (sk, pk) = key(7);
    set("alice.testnet", NearToken::from_millinear(100));
    c.add_signer_key(pk.clone());
    set("relayer.testnet", NearToken::from_yoctonear(0));
    let req = signed(&sk, &pk, &attest_message("alice.testnet", T0 + 60), [1; 32], SELF);
    let _ = c.submit_signed(req.clone());
    let _ = c.submit_signed(req);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn signed_wrong_recipient() {
    let mut c = setup();
    let (sk, pk) = key(7);
    set("alice.testnet", NearToken::from_millinear(100));
    c.add_signer_key(pk.clone());
    set("relayer.testnet", NearToken::from_yoctonear(0));
    let _ = c.submit_signed(signed(
        &sk,
        &pk,
        &attest_message("alice.testnet", T0 + 60),
        [1; 32],
        "other.testnet",
    ));
}

#[test]
#[should_panic(expected = "invalid signature")]
fn signed_tampered_message() {
    let mut c = setup();
    let (sk, pk) = key(7);
    set("alice.testnet", NearToken::from_millinear(100));
    c.add_signer_key(pk.clone());
    set("relayer.testnet", NearToken::from_yoctonear(0));
    let mut req = signed(&sk, &pk, &attest_message("alice.testnet", T0 + 60), [1; 32], SELF);
    req.message = req.message.replace("bob.testnet", "eve.testnet");
    let _ = c.submit_signed(req);
}

#[test]
#[should_panic(expected = "expired")]
fn signed_after_deadline() {
    let mut c = setup();
    let (sk, pk) = key(7);
    set("alice.testnet", NearToken::from_millinear(100));
    c.add_signer_key(pk.clone());
    set("relayer.testnet", NearToken::from_yoctonear(0));
    let _ = c.submit_signed(signed(&sk, &pk, &attest_message("alice.testnet", T0 - 1), [1; 32], SELF));
}

#[test]
#[should_panic(expected = "not a signer key")]
fn signed_unknown_key() {
    let mut c = setup();
    let (sk, pk) = key(7);
    set("alice.testnet", NearToken::from_millinear(100));
    let _ = c.storage_deposit(None, None);
    set("relayer.testnet", NearToken::from_yoctonear(0));
    let _ = c.submit_signed(signed(&sk, &pk, &attest_message("alice.testnet", T0 + 60), [1; 32], SELF));
}

#[test]
fn signed_by_implicit_account() {
    let mut c = setup();
    let (sk, pk) = key(9);
    let implicit = hex::encode(sk.verifying_key().to_bytes());
    set(&implicit, NearToken::from_millinear(100));
    let _ = c.storage_deposit(None, None);
    set("relayer.testnet", NearToken::from_yoctonear(0));
    let o = value(c.submit_signed(signed(&sk, &pk, &attest_message(&implicit, T0 + 60), [3; 32], SELF)));
    assert_eq!(c.get_attestation(o.uid).unwrap().attester.as_str(), implicit);
}

#[test]
fn multisig_threshold() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_millinear(100));
    let ms = c.create_multisig(
        vec![acc("alice.testnet"), acc("bob.testnet"), acc("carol.testnet")],
        2,
        "Board".into(),
    );
    assert_eq!(ms.as_str(), format!("ms-1.{SELF}"));
    assert_eq!(c.get_authority(ms.clone()).unwrap().kind, "multisig");
    let action = MultisigAction::Attest {
        schema_uid: schema(1),
        subject: "dave.testnet".into(),
        data: Base64VecU8(vec![]),
        expiration_time: None,
        ref_uid: None,
    };
    let id = c.propose(ms.clone(), action);
    set("bob.testnet", NearToken::from_yoctonear(0));
    let out = match c.approve(id) {
        PromiseOrValue::Value(v) => v.unwrap(),
        _ => panic!(),
    };
    assert_eq!(out.status, "created");
    assert_eq!(c.get_attestation(out.uid).unwrap().attester, ms);
    assert_eq!(c.get_proposal(id).unwrap().status, crate::multisig::ProposalStatus::Executed);

    set("carol.testnet", NearToken::from_millinear(10));
    let rid = c.propose(ms.clone(), MultisigAction::Revoke { uid: out.uid });
    set("alice.testnet", NearToken::from_yoctonear(0));
    match c.approve(rid) {
        PromiseOrValue::Value(Some(o)) => assert_eq!(o.status, "revoked"),
        _ => panic!("expected the revocation to execute"),
    }
    assert!(c.get_attestation(out.uid).unwrap().revoked);
}

#[test]
#[should_panic(expected = "only members can approve")]
fn multisig_outsider() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_millinear(100));
    let ms = c.create_multisig(vec![acc("alice.testnet"), acc("bob.testnet")], 2, "Pair".into());
    let action = MultisigAction::Attest {
        schema_uid: schema(1),
        subject: "x.testnet".into(),
        data: Base64VecU8(vec![]),
        expiration_time: None,
        ref_uid: None,
    };
    let id = c.propose(ms, action);
    set("mallory.testnet", NearToken::from_yoctonear(0));
    let _ = c.approve(id);
}

#[test]
fn multisig_one_approval_short() {
    let mut c = setup();
    set("alice.testnet", NearToken::from_millinear(100));
    let ms = c.create_multisig(
        vec![acc("alice.testnet"), acc("bob.testnet"), acc("carol.testnet")],
        3,
        "Three".into(),
    );
    let action = MultisigAction::Attest {
        schema_uid: schema(1),
        subject: "x.testnet".into(),
        data: Base64VecU8(vec![]),
        expiration_time: None,
        ref_uid: None,
    };
    let id = c.propose(ms, action);
    set("bob.testnet", NearToken::from_yoctonear(0));
    assert!(matches!(c.approve(id), PromiseOrValue::Value(None)));
    assert_eq!(c.get_proposal(id).unwrap().approvals.len(), 2);
    assert_eq!(c.attestation_count(), 0);
}

#[test]
fn authorities_and_governance() {
    let mut c = setup();
    set("acme.testnet", NearToken::from_millinear(20));
    c.register_authority("Acme Corp".into(), None);
    let a = c.get_authority(acc("acme.testnet")).unwrap();
    assert!(!a.verified);
    assert_eq!(a.kind, "organization");
    set("gov.testnet", NearToken::from_yoctonear(0));
    c.set_authority_verification(acc("acme.testnet"), true);
    assert!(c.get_authority(acc("acme.testnet")).unwrap().verified);
    set("acme.testnet", NearToken::from_yoctonear(0));
    c.register_authority("Acme Corporation".into(), Some("organization".into()));
    assert!(!c.get_authority(acc("acme.testnet")).unwrap().verified, "updating metadata clears verification");
}

#[test]
#[should_panic(expected = "only governance")]
fn verification_needs_governance() {
    let mut c = setup();
    set("acme.testnet", NearToken::from_millinear(20));
    c.register_authority("Acme".into(), None);
    c.set_authority_verification(acc("acme.testnet"), true);
}

#[test]
fn tiers_from_staking_only() {
    let mut c = setup();
    set("owner.testnet", NearToken::from_yoctonear(1));
    c.set_staking(Some(acc("staking.attestra.testnet")));
    set("staking.attestra.testnet", NearToken::from_yoctonear(0));
    c.on_tier_changed(acc("acme.testnet"), Some("gold".into()), U128(10));
    assert_eq!(c.get_tier(acc("acme.testnet")).tier.as_deref(), Some("gold"));
}

#[test]
#[should_panic(expected = "only the staking contract")]
fn tiers_reject_strangers() {
    let mut c = setup();
    set("mallory.testnet", NearToken::from_yoctonear(0));
    c.on_tier_changed(acc("acme.testnet"), Some("gold".into()), U128(10));
}

#[test]
fn ref_uid_must_exist() {
    let mut c = setup();
    let first = attest(&mut c, "alice.testnet", schema(1), "bob.testnet");
    set("alice.testnet", NearToken::from_millinear(50));
    let o = value(c.attest(schema(1), "bob.testnet".into(), Base64VecU8(vec![]), None, Some(first)));
    assert_eq!(c.get_attestation(o.uid).unwrap().ref_uid, Some(first));
}

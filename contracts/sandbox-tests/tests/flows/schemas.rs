//! Schema registration: no resolver, an accepting resolver, a refusing resolver, an account that
//! is not a resolver, and large definitions stored as blobs.

use attestra_sandbox_tests::crypto::{schema_uid, sha256};
use attestra_sandbox_tests::util::{
    event, events, fails_with, millinear, near, ok, receipt_failed_with, yocto, TX_GAS,
};
use attestra_sandbox_tests::Env;
use near_workspaces::AccountId;
use serde_json::{json, Value};

/// 160 bytes at 10^19 yoctoNEAR per byte: the storage registration minimum.
const MIN_STORAGE: u128 = 160 * 10_000_000_000_000_000_000;
/// The 0.1 NEAR `register_schema` attaches.
const DEPOSIT: u128 = 100_000_000_000_000_000_000_000;

#[tokio::test]
async fn schema_registration() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = &env.alice;

    // No resolver: active at once and synced to the attestations contract.
    let definition = "string name, u8 level, bool verified";
    let result = ok(env.register_schema(alice, definition, None, true).await?);
    let uid: Option<String> = result.clone().json()?;
    let uid = uid.expect("registered");
    assert_eq!(uid, schema_uid(definition, None, true));
    let computed: String = env
        .view(
            &env.schemas,
            "compute_schema_uid",
            json!({ "definition": definition, "resolver": null, "revocable": true }),
        )
        .await?;
    assert_eq!(computed, uid);
    assert_eq!(event(&result, "schema_pending")["uid"], uid);
    let registered = event(&result, "schema_registered");
    assert_eq!(registered["authority"], alice.id().as_str());
    assert_eq!(registered["resolver"], Value::Null);
    let schema: Value = env.view(&env.schemas, "get_schema", json!({ "uid": uid })).await?;
    assert_eq!(schema["status"], "active");
    assert_eq!(schema["definition"], definition);
    assert_eq!(schema["authority"], alice.id().as_str());
    let info: Value = env.view(&env.attestations, "get_schema_info", json!({ "uid": uid })).await?;
    assert_eq!(info, json!({ "authority": alice.id(), "resolver": null, "revocable": true }));
    // The three verdict schemas registered during setup come first.
    let count: u32 = env.view(&env.schemas, "schema_count", json!({})).await?;
    assert_eq!(count, 4);
    let listed: Vec<Value> =
        env.view(&env.schemas, "list_schemas", json!({ "from_index": 3, "limit": 5 })).await?;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["uid"], uid);
    fails_with(env.register_schema(alice, definition, None, true).await?, "already exists");

    // A resolver that accepts: the whitelist records the authority as the schema admin.
    let with_resolver = env.schema(alice, "string name", Some(env.whitelist.id()), false).await?;
    let admin: Option<AccountId> =
        env.view(&env.whitelist, "schema_admin", json!({ "schema_uid": with_resolver })).await?;
    assert_eq!(admin.as_ref(), Some(alice.id()));
    let info: Value = env.view(&env.attestations, "get_schema_info", json!({ "uid": with_resolver })).await?;
    assert_eq!(info, json!({ "authority": alice.id(), "resolver": env.whitelist.id(), "revocable": false }));

    // A resolver that refuses (returns false): rolled back, storage refunded.
    let _ = ok(env
        .owner
        .call(env.toggle.id(), "set_answers")
        .args_json(json!({ "answers": { "schema": false, "attest": true, "revoke": true } }))
        .transact()
        .await?);
    let before = env.storage(&env.schemas, alice.id()).await?.expect("registered");
    let refused = ok(env.register_schema(alice, "string refused", Some(env.toggle.id()), true).await?);
    assert_rolled_back(&env, refused, "string refused", env.toggle.id(), "the resolver refused the schema")
        .await?;
    let after = env.storage(&env.schemas, alice.id()).await?.expect("registered");
    // The 0.1 NEAR attached is now available; nothing stays locked for the refused schema.
    assert_eq!(after, (before.0 + DEPOSIT, before.1 + DEPOSIT));

    // An account with no contract is not a resolver.
    let not_resolver = env.register_schema(alice, "string nobody", Some(env.bob.id()), true).await?;
    assert!(not_resolver.is_success());
    assert_rolled_back(&env, not_resolver, "string nobody", env.bob.id(), "the resolver refused the schema")
        .await?;
    // A contract without the resolver interface is not one either.
    let token = env.register_schema(alice, "string token", Some(env.token.id()), true).await?;
    receipt_failed_with(&token, "MethodNotFound");
    assert_rolled_back(&env, token, "string token", env.token.id(), "the resolver refused the schema")
        .await?;
    let after_all = env.storage(&env.schemas, alice.id()).await?.expect("registered");
    assert_eq!(after_all, (after.0 + 2 * DEPOSIT, after.1 + 2 * DEPOSIT));

    // A fresh account gets every yoctoNEAR of its storage back after a rollback.
    let carol = &env.carol;
    let start = env.balance(carol).await?;
    let rolled = env.register_schema(carol, "string carol", Some(env.bob.id()), true).await?;
    let mut burnt = tokens_burnt(&rolled);
    assert_rolled_back(&env, rolled, "string carol", env.bob.id(), "the resolver refused the schema").await?;
    assert_eq!(env.storage(&env.schemas, carol.id()).await?, Some((DEPOSIT, DEPOSIT - MIN_STORAGE)));
    let unregister = ok(carol
        .call(env.schemas.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(yocto(1))
        .transact()
        .await?);
    burnt += tokens_burnt(&unregister);
    assert!(unregister.clone().json::<bool>()?);
    assert_eq!(env.storage(&env.schemas, carol.id()).await?, None);
    // Carol paid for gas and the 1 yoctoNEAR of `storage_unregister`, nothing else.
    let spent = start - env.balance(carol).await?;
    assert_eq!(spent, burnt + 1, "carol spent {spent} yoctoNEAR and burnt {burnt}");

    blobs(&env).await
}

fn tokens_burnt(result: &near_workspaces::result::ExecutionFinalResult) -> u128 {
    result.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear()).sum()
}

/// Checks a revocable schema registration that resolved to null, logged `schema_rejected` and left
/// no trace.
async fn assert_rolled_back(
    env: &Env,
    result: near_workspaces::result::ExecutionFinalResult,
    definition: &str,
    resolver: &AccountId,
    reason: &str,
) -> anyhow::Result<()> {
    let uid = schema_uid(definition, Some(resolver.as_str()), true);
    let rejected = events(&result, "schema_rejected");
    assert_eq!(rejected.len(), 1, "logs: {:#?}", result.logs());
    assert_eq!(rejected[0]["reason"], reason);
    assert_eq!(rejected[0]["uid"], uid);
    let returned: Option<String> = result.json()?;
    assert_eq!(returned, None);
    let schema: Option<Value> = env.view(&env.schemas, "get_schema", json!({ "uid": uid })).await?;
    assert!(schema.is_none());
    let info: Option<Value> = env.view(&env.attestations, "get_schema_info", json!({ "uid": uid })).await?;
    assert!(info.is_none());
    Ok(())
}

/// Large definitions go through a stored blob and get the UID of the same text inline.
async fn blobs(env: &Env) -> anyhow::Result<()> {
    let dave = &env.dave;
    // 240 fields with 64-byte names: about 17.5 KiB, over the 16 KiB inline limit.
    let large: String =
        (0..240).map(|i| format!("string f{i:03}_{}", "x".repeat(59))).collect::<Vec<_>>().join(", ");
    assert!(large.len() > 16 * 1024);
    let inline = dave
        .call(env.schemas.id(), "register_schema")
        .args_json(json!({ "definition": large, "resolver": null, "revocable": true }))
        .deposit(near(1))
        .gas(TX_GAS)
        .transact()
        .await?;
    fails_with(inline, "definition too long");

    let stored = ok(dave
        .call(env.schemas.id(), "store_blob")
        .args_json(json!({ "content": large }))
        .deposit(near(1))
        .gas(TX_GAS)
        .transact()
        .await?);
    let hash: String = stored.clone().json()?;
    assert_eq!(hash, hex::encode(sha256(large.as_bytes())));
    assert_eq!(event(&stored, "blob_stored")["size"], large.len());
    let blob: Option<String> = env.view(&env.schemas, "get_blob", json!({ "hash": hash })).await?;
    assert_eq!(blob.as_deref(), Some(large.as_str()));

    let from_blob = ok(dave
        .call(env.schemas.id(), "register_schema_from_blob")
        .args_json(json!({ "blob_hash": hash, "resolver": null, "revocable": true }))
        .deposit(millinear(100))
        .gas(TX_GAS)
        .transact()
        .await?);
    let uid: Option<String> = from_blob.json()?;
    assert_eq!(uid.as_deref(), Some(schema_uid(&large, None, true).as_str()));
    let schema: Value = env.view(&env.schemas, "get_schema", json!({ "uid": uid })).await?;
    assert_eq!(schema["blob_hash"], hash);
    assert_eq!(schema["status"], "active");
    assert_eq!(schema["definition"].as_str(), Some(large.as_str()));

    // A definition that also fits inline: the blob path yields the inline UID, so registering it
    // inline afterwards is a duplicate.
    let medium = "string title, u64 score, account_id reviewer, bytes32 digest, string[] tags";
    let hash: String = ok(dave
        .call(env.schemas.id(), "store_blob")
        .args_json(json!({ "content": medium }))
        .deposit(millinear(100))
        .gas(TX_GAS)
        .transact()
        .await?)
    .json()?;
    let inline_uid: String = env
        .view(
            &env.schemas,
            "compute_schema_uid",
            json!({ "definition": medium, "resolver": null, "revocable": false }),
        )
        .await?;
    let uid: Option<String> = ok(dave
        .call(env.schemas.id(), "register_schema_from_blob")
        .args_json(json!({ "blob_hash": hash, "resolver": null, "revocable": false }))
        .deposit(millinear(100))
        .gas(TX_GAS)
        .transact()
        .await?)
    .json()?;
    assert_eq!(uid, Some(inline_uid));
    fails_with(env.register_schema(dave, medium, None, false).await?, "already exists");
    let unknown = dave
        .call(env.schemas.id(), "register_schema_from_blob")
        .args_json(json!({ "blob_hash": "00".repeat(32), "resolver": null, "revocable": false }))
        .deposit(millinear(100))
        .gas(TX_GAS)
        .transact()
        .await?;
    fails_with(unknown, "unknown blob");
    Ok(())
}

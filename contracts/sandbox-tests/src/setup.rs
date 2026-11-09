//! Deploys every contract the way production does: one root account (`attestra.test.near`)
//! owns sub-accounts for each contract, and the init calls wire them together.

use crate::crypto::{self, ed_key, near_public_key, secp_key};
use crate::util::{millinear, near, ok, tokens, yocto, TX_GAS};
use ed25519_dalek::SigningKey;
use k256::ecdsa::SigningKey as SecpKey;
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::path::PathBuf;

pub const AI_CHECK_SCHEMA: &str =
    "string rule_id, string claim, bool result, bytes32 evidence_hash, string model, bytes32 request_id, u64 checked_at";
pub const FOREIGN_TX_SCHEMA: &str =
    "string chain, bytes32 tx_id, u64 block_number, bytes emitter, bytes32[] topics, bytes data, u64 log_index";
pub const WALLET_LINK_SCHEMA: &str = "string chain, string address, string caip10";

pub const MODEL: &str = "test/model-1";
pub const RULE: &str = "age_over_18";
pub const CLAIM: &str = "is at least 18 years old";

/// Reads a wasm built by `build.sh`, or fails with what to run.
pub fn wasm(crate_name: &str) -> Vec<u8> {
    let file = crate_name.replace('-', "_");
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("target")
        .join("near")
        .join(&file)
        .join(format!("{file}.wasm"));
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "missing wasm {} ({e}). Build the contracts first: cd contracts/sandbox-tests && ./build.sh",
            path.display()
        )
    })
}

/// The off-chain keys the verdicts contract trusts.
pub struct Keys {
    pub enclave: SigningKey,
    pub nearai_ed: SigningKey,
    pub nearai_ecdsa: SecpKey,
    pub mpc: SecpKey,
}

pub struct VerdictSchemas {
    pub ai_check: String,
    pub foreign_tx: String,
    pub wallet_link: String,
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    /// `attestra.test.near`, owner of every contract.
    pub owner: Account,
    pub schemas: Contract,
    pub attestations: Contract,
    pub verdicts: Contract,
    pub credentials: Contract,
    pub staking: Contract,
    pub token: Contract,
    pub whitelist: Contract,
    pub fee: Contract,
    pub gated: Contract,
    pub reward: Contract,
    pub pipeline: Contract,
    /// Resolver double whose answers the test sets.
    pub toggle: Contract,
    /// MPC double.
    pub mpc: Contract,
    pub alice: Account,
    pub bob: Account,
    pub carol: Account,
    pub dave: Account,
    pub eve: Account,
    pub relayer: Account,
    pub keys: Keys,
    pub verdict_schemas: VerdictSchemas,
}

struct Spec {
    name: &'static str,
    wasm: &'static str,
    init: Value,
}

impl Env {
    pub async fn new() -> anyhow::Result<Env> {
        let started = std::time::Instant::now();
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let owner = root.create_subaccount("attestra").initial_balance(near(5_000)).transact().await?;
        let owner = owner.into_result()?;
        let o = owner.id().clone();
        let id = |name: &str| -> AccountId { format!("{name}.{o}").parse().expect("account id") };

        let resolver = |kind: &str| json!({ "owner": o, "kind": kind, "schemas": id("schemas"), "attestations": id("attestations") });
        let specs = vec![
            Spec {
                name: "schemas",
                wasm: "attestra_schemas",
                init: json!({ "owner": o, "attestations": id("attestations") }),
            },
            Spec {
                name: "attestations",
                wasm: "attestra_attestations",
                init: json!({ "owner": o, "governance": o, "schemas": id("schemas") }),
            },
            Spec {
                name: "credentials",
                wasm: "attestra_credentials",
                init: json!({ "owner": o, "attestations": id("attestations") }),
            },
            Spec {
                name: "token",
                wasm: "attestra_token",
                init: json!({ "owner": o, "total_supply": tokens(1_000_000) }),
            },
            Spec {
                name: "staking",
                wasm: "attestra_staking",
                init: json!({ "owner": o, "token": id("token"), "attestations": id("attestations"), "tiers": [] }),
            },
            Spec { name: "whitelist", wasm: "attestra_resolvers", init: resolver("whitelist") },
            Spec { name: "fee", wasm: "attestra_resolvers", init: resolver("fee") },
            Spec { name: "gated", wasm: "attestra_resolvers", init: resolver("token_gated") },
            Spec { name: "reward", wasm: "attestra_resolvers", init: resolver("token_reward") },
            Spec { name: "pipeline", wasm: "attestra_resolvers", init: resolver("pipeline") },
            Spec {
                name: "toggle",
                wasm: "attestra_resolver_double",
                init: json!({ "owner": o, "answers": { "schema": true, "attest": true, "revoke": true } }),
            },
            Spec { name: "mpc", wasm: "attestra_mpc_double", init: json!({ "owner": o }) },
            Spec {
                name: "verdicts",
                wasm: "attestra_verdicts",
                init: json!({ "owner": o, "attestations": id("attestations"), "mpc": id("mpc") }),
            },
        ];

        // One batch per contract (create, fund, key, deploy, init), all sent before waiting so
        // they land in the same few blocks. The owner key also controls every contract account.
        let key = owner.secret_key().clone();
        let mut pending = Vec::new();
        for spec in &specs {
            let code = wasm(spec.wasm);
            let status = owner
                .batch(&id(spec.name))
                .create_account()
                .transfer(near(50))
                .add_key(key.public_key(), AccessKey::full_access())
                .deploy(&code)
                .call(Function::new("new").args_json(spec.init.clone()).gas(Gas::from_tgas(100)))
                .transact_async()
                .await?;
            pending.push(status);
        }
        let mut users = Vec::new();
        for name in ["alice", "bob", "carol", "dave", "eve", "relayer"] {
            let user_key = SecretKey::from_random(KeyType::ED25519);
            let user_id: AccountId = format!("{name}.{}", root.id()).parse()?;
            let status = root
                .batch(&user_id)
                .create_account()
                .transfer(near(100))
                .add_key(user_key.public_key(), AccessKey::full_access())
                .transact_async()
                .await?;
            pending.push(status);
            users.push(Account::from_secret_key(user_id, user_key, &worker));
        }
        for status in pending {
            let _ = ok(status.await?);
        }
        let contract = |name: &str| Contract::from_secret_key(id(name), key.clone(), &worker);
        let mut users = users.into_iter();
        let mut user = || users.next().expect("user");

        let keys =
            Keys { enclave: ed_key(1), nearai_ed: ed_key(2), nearai_ecdsa: secp_key(3), mpc: secp_key(4) };
        let (ai_check, foreign_tx, wallet_link) = (
            crypto::schema_uid(AI_CHECK_SCHEMA, None, true),
            crypto::schema_uid(FOREIGN_TX_SCHEMA, None, true),
            crypto::schema_uid(WALLET_LINK_SCHEMA, None, true),
        );
        let env = Env {
            schemas: contract("schemas"),
            attestations: contract("attestations"),
            verdicts: contract("verdicts"),
            credentials: contract("credentials"),
            staking: contract("staking"),
            token: contract("token"),
            whitelist: contract("whitelist"),
            fee: contract("fee"),
            gated: contract("gated"),
            reward: contract("reward"),
            pipeline: contract("pipeline"),
            toggle: contract("toggle"),
            mpc: contract("mpc"),
            alice: user(),
            bob: user(),
            carol: user(),
            dave: user(),
            eve: user(),
            relayer: user(),
            keys,
            verdict_schemas: VerdictSchemas { ai_check, foreign_tx, wallet_link },
            worker,
            owner,
        };
        env.wire().await?;
        println!("sandbox ready in {:.1}s", started.elapsed().as_secs_f64());
        Ok(env)
    }

    /// The calls that connect the contracts after their init.
    async fn wire(&self) -> anyhow::Result<()> {
        let o = &self.owner;
        let mut pending = Vec::new();
        let send = |contract: &AccountId, method: &str, args: Value, deposit: NearToken| {
            o.call(contract, method).args_json(args).deposit(deposit).gas(TX_GAS)
        };
        let a = self.attestations.id();
        let calls = vec![
            send(a, "set_credentials", json!({ "credentials": self.credentials.id() }), yocto(1)),
            send(a, "set_staking", json!({ "staking": self.staking.id() }), yocto(1)),
            send(
                self.whitelist.id(),
                "add_trusted_pipeline",
                json!({ "account_id": self.pipeline.id() }),
                yocto(0),
            ),
            send(
                self.fee.id(),
                "add_trusted_pipeline",
                json!({ "account_id": self.pipeline.id() }),
                yocto(0),
            ),
            send(
                self.gated.id(),
                "add_trusted_pipeline",
                json!({ "account_id": self.pipeline.id() }),
                yocto(0),
            ),
            send(
                self.reward.id(),
                "add_trusted_pipeline",
                json!({ "account_id": self.pipeline.id() }),
                yocto(0),
            ),
            send(self.token.id(), "storage_deposit", json!({ "account_id": self.fee.id() }), millinear(10)),
            send(
                self.token.id(),
                "storage_deposit",
                json!({ "account_id": self.reward.id() }),
                millinear(10),
            ),
            send(
                self.token.id(),
                "storage_deposit",
                json!({ "account_id": self.staking.id() }),
                millinear(10),
            ),
            // The verdicts contract attests as itself and pays storage from this balance.
            send(a, "storage_deposit", json!({ "account_id": self.verdicts.id() }), near(2)),
            send(
                self.schemas.id(),
                "register_schema",
                json!({ "definition": AI_CHECK_SCHEMA, "resolver": null, "revocable": true }),
                millinear(100),
            ),
            send(
                self.schemas.id(),
                "register_schema",
                json!({ "definition": FOREIGN_TX_SCHEMA, "resolver": null, "revocable": true }),
                millinear(100),
            ),
            send(
                self.schemas.id(),
                "register_schema",
                json!({ "definition": WALLET_LINK_SCHEMA, "resolver": null, "revocable": true }),
                millinear(100),
            ),
        ];
        for call in calls {
            pending.push(call.transact_async().await?);
        }
        let k = &self.keys;
        let v = self.verdicts.id();
        let s = &self.verdict_schemas;
        let config = vec![
            send(
                v,
                "set_schemas",
                json!({ "ai_check": s.ai_check, "foreign_tx": s.foreign_tx, "wallet_link": s.wallet_link }),
                yocto(1),
            ),
            send(v, "set_enclave_keys", json!({ "keys": [near_public_key(&k.enclave)] }), yocto(1)),
            send(
                v,
                "set_model_signers",
                json!({ "signers": [
                    { "model": MODEL, "algo": "ed25519", "key": hex::encode(k.nearai_ed.verifying_key().to_bytes()) },
                    { "model": MODEL, "algo": "ecdsa", "key": crypto::eth_address(&k.nearai_ecdsa) },
                ] }),
                yocto(1),
            ),
            send(
                v,
                "set_rules",
                json!({ "rules": [
                    { "id": RULE, "claim": CLAIM, "enabled": true },
                    { "id": "off_rule", "claim": "is disabled", "enabled": false },
                ] }),
                yocto(1),
            ),
            send(
                v,
                "set_mpc_key",
                json!({ "public_key": crypto::mpc_public_key(&k.mpc), "domain_id": null }),
                yocto(1),
            ),
        ];
        for call in config {
            pending.push(call.transact_async().await?);
        }
        for status in pending {
            let _ = ok(status.await?);
        }
        for uid in [&s.ai_check, &s.foreign_tx, &s.wallet_link] {
            let info: Option<Value> =
                self.view(&self.attestations, "get_schema_info", json!({ "uid": uid })).await?;
            anyhow::ensure!(info.is_some(), "verdict schema {uid} did not sync");
        }
        Ok(())
    }

    // ---------------------------------------------------------------- calls and views

    pub async fn view<T: DeserializeOwned>(
        &self,
        contract: &Contract,
        method: &str,
        args: Value,
    ) -> anyhow::Result<T> {
        Ok(self.worker.view(contract.id(), method).args_json(args).await?.json()?)
    }

    /// `register_schema` with 0.1 NEAR attached.
    pub async fn register_schema(
        &self,
        who: &Account,
        definition: &str,
        resolver: Option<&AccountId>,
        revocable: bool,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.schemas.id(), "register_schema")
            .args_json(json!({ "definition": definition, "resolver": resolver, "revocable": revocable }))
            .deposit(millinear(100))
            .gas(TX_GAS)
            .transact()
            .await?)
    }

    /// Registers a schema and returns its UID; panics unless it became active.
    pub async fn schema(
        &self,
        who: &Account,
        definition: &str,
        resolver: Option<&AccountId>,
        revocable: bool,
    ) -> anyhow::Result<String> {
        let result = ok(self.register_schema(who, definition, resolver, revocable).await?);
        let uid: Option<String> = result.json()?;
        let uid = uid.expect("the schema was registered");
        assert_eq!(uid, crypto::schema_uid(definition, resolver.map(|r| r.as_str()), revocable));
        Ok(uid)
    }

    /// `attest` from `who` with `deposit` attached.
    pub async fn attest(
        &self,
        who: &Account,
        schema_uid: &str,
        subject: &str,
        data: &[u8],
        expiration_time: Option<u64>,
        deposit: NearToken,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.attestations.id(), "attest")
            .args_json(json!({
                "schema_uid": schema_uid, "subject": subject, "data": crypto::b64(data),
                "expiration_time": expiration_time, "ref_uid": null,
            }))
            .deposit(deposit)
            .gas(TX_GAS)
            .transact()
            .await?)
    }

    /// Attests with 0.1 NEAR and returns the outcome `{ uid, status }`.
    pub async fn attest_ok(
        &self,
        who: &Account,
        schema_uid: &str,
        subject: &str,
        data: &[u8],
    ) -> anyhow::Result<(Value, ExecutionFinalResult)> {
        let result = ok(self.attest(who, schema_uid, subject, data, None, millinear(100)).await?);
        let outcome: Value = result.clone().json()?;
        Ok((outcome, result))
    }

    pub async fn revoke(&self, who: &Account, uid: &str) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.attestations.id(), "revoke")
            .args_json(json!({ "uid": uid }))
            .gas(TX_GAS)
            .transact()
            .await?)
    }

    pub async fn attestation(&self, uid: &str) -> anyhow::Result<Option<Value>> {
        self.view(&self.attestations, "get_attestation", json!({ "uid": uid })).await
    }

    pub async fn attestation_count(&self) -> anyhow::Result<u64> {
        self.view(&self.attestations, "attestation_count", json!({})).await
    }

    /// `storage_balance_of` on the attestations contract as `(total, available)`.
    pub async fn storage(
        &self,
        contract: &Contract,
        account: &AccountId,
    ) -> anyhow::Result<Option<(u128, u128)>> {
        let b: Option<Value> =
            self.view(contract, "storage_balance_of", json!({ "account_id": account })).await?;
        Ok(b.map(|b| (crate::util::u128_of(&b["total"]), crate::util::u128_of(&b["available"]))))
    }

    pub async fn ft_balance(&self, account: &AccountId) -> anyhow::Result<u128> {
        let b: Value = self.view(&self.token, "ft_balance_of", json!({ "account_id": account })).await?;
        Ok(crate::util::u128_of(&b))
    }

    /// `ft_transfer_call` of `amount` yocto tATT from `who` to `receiver`.
    pub async fn ft_transfer_call(
        &self,
        who: &Account,
        receiver: &AccountId,
        amount: u128,
        msg: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.token.id(), "ft_transfer_call")
            .args_json(
                json!({ "receiver_id": receiver, "amount": amount.to_string(), "memo": null, "msg": msg }),
            )
            .deposit(yocto(1))
            .gas(TX_GAS)
            .transact()
            .await?)
    }

    pub async fn faucet(&self, who: &Account) -> anyhow::Result<()> {
        let _ = ok(who.call(self.token.id(), "faucet").gas(TX_GAS).transact().await?);
        Ok(())
    }

    /// The account's NEAR balance in yocto, once the gas refunds of earlier calls (which land a
    /// block or two after the transaction outcome) have arrived.
    pub async fn balance(&self, account: &Account) -> anyhow::Result<u128> {
        self.worker.fast_forward(3).await?;
        Ok(account.view_account().await?.balance.as_yoctonear())
    }
}

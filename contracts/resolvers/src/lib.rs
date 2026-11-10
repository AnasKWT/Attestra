//! Attestra resolvers. One wasm, deployed once per kind (chosen at init):
//!
//! - `whitelist`: only whitelisted attesters may attest under a schema.
//! - `fee`: attesters pay a per-schema fee (NEAR or one NEP-141 token the owner accepted) from a
//!   prepaid balance.
//! - `token_gated`: attesters must hold a minimum balance of an NEP-141 token.
//! - `token_reward`: the subject receives NEP-141 tokens from a per-schema pool once the
//!   attestation is stored.
//! - `pipeline`: up to four resolvers run in order; a refusal aborts the ones that approved.
//!
//! Each schema that names a resolver registers with it through `on_schema_registered`, which
//! records the schema's authority as the admin of that schema's settings. Setters charge the
//! storage they add to the attached deposit and refund the rest. Entries the hooks write on their
//! own (admins, prepaid balances, fees in flight, collected fees, reward tallies, pipeline runs)
//! are small and paid by the resolver account, which the deployer keeps funded.

mod fee;
mod gate;
mod pipeline;
mod reward;
#[cfg(test)]
mod tests;
mod whitelist;

use attestra_common::events::{emit, RESOLVER_CONFIGURED};
use attestra_common::resolver::{ResolverCall, ResolverOp};
use attestra_common::Uid;
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

pub use fee::FeeView;
pub use gate::GateView;
pub use reward::RewardView;

use fee::{Charge, Fee};
use gate::Gate;
use reward::Reward;

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// `ft_transfer` on a token contract.
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
/// `ft_balance_of` on a token contract.
const GAS_FT_VIEW: Gas = Gas::from_tgas(5);
/// `storage_deposit` on a token contract.
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
/// A callback on this contract that only updates its own state.
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResolverKind {
    Whitelist,
    Fee,
    TokenGated,
    TokenReward,
    Pipeline,
}

impl ResolverKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ResolverKind::Whitelist => "whitelist",
            ResolverKind::Fee => "fee",
            ResolverKind::TokenGated => "token_gated",
            ResolverKind::TokenReward => "token_reward",
            ResolverKind::Pipeline => "pipeline",
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolverInfo {
    pub kind: ResolverKind,
    pub owner: AccountId,
    pub schemas: AccountId,
    pub attestations: AccountId,
    pub trusted_pipelines: Vec<AccountId>,
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Admins,
    Whitelist,
    Fees,
    Balances,
    Collected,
    Charged,
    Gates,
    Rewards,
    Distributed,
    Pipelines,
    Runs,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    kind: ResolverKind,
    schemas: AccountId,
    attestations: AccountId,
    /// Pipelines allowed to call the hooks and `on_schema_registered` like the core contracts.
    trusted_pipelines: Vec<AccountId>,
    /// Schema UID to the account that may change that schema's settings.
    admins: LookupMap<Uid, AccountId>,
    whitelist: LookupSet<(Uid, AccountId)>,
    fees: LookupMap<Uid, Fee>,
    /// Prepaid fee balances by (payer, token); None is NEAR. Empty balances are removed.
    balances: LookupMap<(AccountId, Option<AccountId>), u128>,
    /// Committed fees by (schema, token), waiting for the admin to withdraw them.
    collected: LookupMap<(Uid, Option<AccountId>), u128>,
    /// Fees charged by `on_attest` whose attestation is not committed or aborted yet.
    charged: LookupMap<Uid, Charge>,
    gates: LookupMap<Uid, Gate>,
    rewards: LookupMap<Uid, Reward>,
    /// Rewards paid by (schema, subject).
    distributed: LookupMap<(Uid, AccountId), u128>,
    pipelines: LookupMap<Uid, Vec<AccountId>>,
    /// The resolvers that approved an attestation, until it is committed or aborted.
    runs: LookupMap<Uid, Vec<AccountId>>,
    /// NEP-141 tokens a fee resolver accepts for fees and prepaid balances. Any account can call
    /// `ft_on_transfer`, so without this list anyone could create balance entries (storage this
    /// resolver pays for) by posing as a token.
    fee_tokens: Vec<AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, kind: ResolverKind, schemas: AccountId, attestations: AccountId) -> Self {
        Self {
            owner,
            kind,
            schemas,
            attestations,
            trusted_pipelines: Vec::new(),
            admins: LookupMap::new(Key::Admins),
            whitelist: LookupSet::new(Key::Whitelist),
            fees: LookupMap::new(Key::Fees),
            balances: LookupMap::new(Key::Balances),
            collected: LookupMap::new(Key::Collected),
            charged: LookupMap::new(Key::Charged),
            gates: LookupMap::new(Key::Gates),
            rewards: LookupMap::new(Key::Rewards),
            distributed: LookupMap::new(Key::Distributed),
            pipelines: LookupMap::new(Key::Pipelines),
            runs: LookupMap::new(Key::Runs),
            fee_tokens: Vec::new(),
        }
    }

    // Owner

    pub fn add_trusted_pipeline(&mut self, account_id: AccountId) {
        self.assert_owner();
        if !self.trusted_pipelines.contains(&account_id) {
            self.trusted_pipelines.push(account_id.clone());
            self.configured(None, "trusted_pipeline_added", json!(account_id));
        }
    }

    pub fn remove_trusted_pipeline(&mut self, account_id: AccountId) {
        self.assert_owner();
        if let Some(i) = self.trusted_pipelines.iter().position(|a| *a == account_id) {
            self.trusted_pipelines.remove(i);
            self.configured(None, "trusted_pipeline_removed", json!(account_id));
        }
    }

    // Resolver interface

    /// Records `authority` as the admin of `schema_uid`. The first registration wins: a later
    /// call with another authority returns false, the same authority returns true.
    pub fn on_schema_registered(&mut self, schema_uid: Uid, authority: AccountId) -> bool {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.schemas || self.trusted_pipelines.contains(&caller),
            "only the schemas contract or a trusted pipeline can register a schema"
        );
        match self.admins.get(&schema_uid) {
            Some(admin) => *admin == authority,
            None => {
                self.admins.insert(schema_uid, authority.clone());
                self.configured(Some(&schema_uid), "admin", json!(authority));
                true
            }
        }
    }

    pub fn on_attest(&mut self, call: ResolverCall) -> PromiseOrValue<bool> {
        self.assert_hook_caller();
        match self.kind {
            ResolverKind::Whitelist => PromiseOrValue::Value(self.whitelist_allows(&call)),
            ResolverKind::Fee => PromiseOrValue::Value(self.charge_fee(&call)),
            ResolverKind::TokenGated => self.check_gate(&call),
            ResolverKind::TokenReward => PromiseOrValue::Value(true),
            ResolverKind::Pipeline => self.run_pipeline(call),
        }
    }

    pub fn on_revoke(&mut self, call: ResolverCall) -> PromiseOrValue<bool> {
        self.assert_hook_caller();
        match self.kind {
            ResolverKind::Pipeline => self.run_pipeline(call),
            _ => PromiseOrValue::Value(true),
        }
    }

    pub fn on_aborted(&mut self, call: ResolverCall) {
        self.assert_hook_caller();
        match self.kind {
            ResolverKind::Fee => self.refund_fee(&call),
            ResolverKind::Pipeline => self.forward_pipeline(&call, false),
            _ => {}
        }
    }

    pub fn on_committed(&mut self, call: ResolverCall) {
        self.assert_hook_caller();
        match self.kind {
            ResolverKind::Fee => self.commit_fee(&call),
            ResolverKind::TokenReward => self.pay_reward(&call),
            ResolverKind::Pipeline => self.forward_pipeline(&call, true),
            _ => {}
        }
    }

    /// NEP-141 receiver. Fee: `""` or `"deposit"` credits the sender's prepaid balance in the
    /// calling token. Token reward: `{"fund":"<schema uid>"}` from the schema's reward token adds
    /// to its pool. Anything else is returned to the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        match self.kind {
            ResolverKind::Fee => self.fee_on_transfer(token, sender_id, amount.0, &msg),
            ResolverKind::TokenReward => self.reward_on_transfer(token, sender_id, amount.0, &msg),
            _ => env::panic_str("not a fee or token_reward resolver"),
        }
    }

    // Views

    pub fn resolver_info(&self) -> ResolverInfo {
        ResolverInfo {
            kind: self.kind,
            owner: self.owner.clone(),
            schemas: self.schemas.clone(),
            attestations: self.attestations.clone(),
            trusted_pipelines: self.trusted_pipelines.clone(),
        }
    }

    pub fn schema_admin(&self, schema_uid: Uid) -> Option<AccountId> {
        self.admins.get(&schema_uid).cloned()
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }

    fn require_kind(&self, kind: ResolverKind) {
        if self.kind != kind {
            env::panic_str(&format!("not a {} resolver", kind.as_str()));
        }
    }

    fn assert_hook_caller(&self) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.attestations || self.trusted_pipelines.contains(&caller),
            "only the attestations contract or a trusted pipeline can call resolver hooks"
        );
    }

    /// Panics unless the caller is the admin of `schema_uid`; returns the admin.
    fn assert_admin(&self, schema_uid: &Uid) -> AccountId {
        let admin = self
            .admins
            .get(schema_uid)
            .unwrap_or_else(|| env::panic_str("the schema is not registered with this resolver"));
        require!(env::predecessor_account_id() == *admin, "only the schema admin can change its settings");
        admin.clone()
    }

    fn configured(&self, schema_uid: Option<&Uid>, setting: &str, value: Value) {
        emit(
            RESOLVER_CONFIGURED,
            &json!({ "kind": self.kind, "schema_uid": schema_uid, "setting": setting, "value": value }),
        );
    }
}

/// Bytes written since `before`, in yoctoNEAR.
fn storage_cost(before: u64) -> u128 {
    env::storage_usage().saturating_sub(before) as u128 * env::storage_byte_cost().as_yoctonear()
}

/// Charges the storage a setter wrote since `before` to the attached deposit and refunds the
/// rest to the caller. Collections must be flushed first so the bytes are counted.
fn settle_deposit(before: u64) {
    let deposit = env::attached_deposit().as_yoctonear();
    let cost = storage_cost(before);
    require!(deposit >= cost, format!("attach at least {cost} yoctoNEAR to cover the storage"));
    refund(&env::predecessor_account_id(), deposit - cost);
}

fn refund(account_id: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(account_id.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
    }
}

/// Sends NEAR (`token` None) or an NEP-141 token.
fn send(receiver_id: &AccountId, token: &Option<AccountId>, amount: u128) -> Promise {
    match token {
        None => Promise::new(receiver_id.clone()).transfer(NearToken::from_yoctonear(amount)),
        Some(token) => ext_ft_core::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(receiver_id.clone(), U128(amount), None),
    }
}

/// The callback builder for this contract with a fixed gas budget.
fn this(gas: Gas) -> ContractExt {
    Contract::ext(env::current_account_id()).with_static_gas(gas).with_unused_gas_weight(0)
}

fn is_attest(call: &ResolverCall) -> bool {
    call.op == ResolverOp::Attest
}

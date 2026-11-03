//! The resolver interface.
//!
//! A resolver is any account that implements these methods. Calls are asynchronous: the
//! attestations contract keeps the operation pending, calls the resolver, and commits or rolls
//! back in its callback.
//!
//! - `on_schema_registered` is called by the schemas contract when a schema names the resolver;
//!   returning false (or failing) rolls the registration back. A resolver uses it to record the
//!   schema's authority as the admin of that schema's settings.
//! - `on_attest` and `on_revoke` approve (true) or refuse (false) an operation. They may return a
//!   promise that resolves to a bool.
//! - `on_aborted` undoes the side effects of an approved `on_attest` when a later step refused
//!   (a pipeline), for example refunding a fee.
//! - `on_committed` runs after the attestation is stored, for side effects such as rewards. Its
//!   outcome never changes the attestation.

use crate::Uid;
use near_sdk::json_types::Base64VecU8;
use near_sdk::{ext_contract, near, AccountId, PromiseOrValue};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResolverOp {
    Attest,
    Revoke,
    Schedule,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolverCall {
    pub op: ResolverOp,
    pub attestation_uid: Uid,
    pub schema_uid: Uid,
    /// The authority the attestation is (or will be) recorded under.
    pub attester: AccountId,
    /// Who acted: the attester, a delegate, a multisig member or the relayer's signer.
    pub actor: AccountId,
    pub subject: String,
    pub data: Base64VecU8,
}

#[ext_contract(ext_resolver)]
pub trait Resolver {
    fn on_schema_registered(&mut self, schema_uid: Uid, authority: AccountId) -> bool;
    fn on_attest(&mut self, call: ResolverCall) -> PromiseOrValue<bool>;
    fn on_revoke(&mut self, call: ResolverCall) -> PromiseOrValue<bool>;
    fn on_aborted(&mut self, call: ResolverCall);
    fn on_committed(&mut self, call: ResolverCall);
}

/// What the schemas contract tells the attestations contract about a registered schema.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchemaInfo {
    pub authority: AccountId,
    pub resolver: Option<AccountId>,
    pub revocable: bool,
}

#[ext_contract(ext_attestations)]
pub trait AttestationsHooks {
    fn sync_schema(&mut self, uid: Uid, info: SchemaInfo);
    fn on_tier_changed(
        &mut self,
        account_id: AccountId,
        tier: Option<String>,
        staked: near_sdk::json_types::U128,
    );
}

#[ext_contract(ext_credentials)]
pub trait CredentialsHooks {
    fn on_attestation_revoked(&mut self, attestation_uid: Uid);
}

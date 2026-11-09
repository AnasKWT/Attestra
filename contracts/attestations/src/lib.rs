//! Attestra attestations.
//!
//! An attestation is a signed-by-transaction claim by an attester about a subject, shaped by a
//! schema. This contract stores attestations and everything that decides who may issue or revoke
//! them: authorities (verified by governance), delegates with a scope and an expiry, NEP-413
//! signed requests that anyone can submit, and k-of-n multisig authorities.
//!
//! When a schema has a resolver, an operation waits as pending while the resolver decides, and the
//! callback commits it or rolls it back with a storage refund (see `gate.rs`).

mod authority;
mod gate;
mod multisig;
mod ops;
#[cfg(test)]
mod tests;

use attestra_common::resolver::SchemaInfo;
use attestra_common::storage::{StorageBalance, StorageBalanceBounds, StorageLedger};
use attestra_common::uid::Uid;
use attestra_common::{events, now_secs};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault};

pub use authority::{Authority, AuthorityView, DelegateGrant, DelegateScope, DelegateView};
pub use gate::PendingOp;
pub use multisig::{Multisig, MultisigAction, Proposal};
pub use ops::{Outcome, SignedRequest};

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Schemas,
    Attestations,
    Nonces,
    Authorities,
    Tiers,
    Delegates,
    DelegateLists,
    SignerKeys,
    UsedNonces,
    ExpiryRecorded,
    Multisigs,
    Proposals,
    Pending,
    Ledger,
}

/// Where an attestation is in its lifecycle. Expiry and scheduled revocation are computed from
/// time on every read, so they need no transaction.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Waiting for the schema's resolver to approve it.
    Pending,
    Active,
    /// A revocation (or a scheduled one) waits for the resolver.
    Revoking,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Attestation {
    pub schema_uid: Uid,
    pub attester: AccountId,
    pub subject: String,
    pub data: Vec<u8>,
    pub created_at: u64,
    pub expiration_time: u64,
    pub revoked: bool,
    pub revocation_time: u64,
    pub revoke_at: u64,
    pub nonce: u64,
    pub ref_uid: Option<Uid>,
    pub state: State,
    /// The account whose storage balance pays for this record.
    pub payer: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestationView {
    pub uid: Uid,
    pub schema_uid: Uid,
    pub attester: AccountId,
    pub subject: String,
    pub data: Base64VecU8,
    pub created_at: u64,
    pub expiration_time: u64,
    pub revoked: bool,
    pub revocation_time: u64,
    pub revoke_at: u64,
    pub nonce: u64,
    pub ref_uid: Option<Uid>,
    /// `pending`, `active`, `revoking`, `revoked` or `expired`.
    pub status: String,
}

impl Attestation {
    pub fn status(&self, now: u64) -> &'static str {
        if self.state == State::Pending {
            "pending"
        } else if self.revoked || (self.revoke_at != 0 && now >= self.revoke_at) {
            "revoked"
        } else if self.expiration_time != 0 && now > self.expiration_time {
            "expired"
        } else if self.state == State::Revoking {
            "revoking"
        } else {
            "active"
        }
    }

    fn view(&self, uid: Uid) -> AttestationView {
        AttestationView {
            uid,
            schema_uid: self.schema_uid,
            attester: self.attester.clone(),
            subject: self.subject.clone(),
            data: Base64VecU8(self.data.clone()),
            created_at: self.created_at,
            expiration_time: self.expiration_time,
            revoked: self.revoked || (self.revoke_at != 0 && now_secs() >= self.revoke_at),
            revocation_time: if self.revoked {
                self.revocation_time
            } else if self.revoke_at != 0 && now_secs() >= self.revoke_at {
                self.revoke_at
            } else {
                0
            },
            revoke_at: self.revoke_at,
            nonce: self.nonce,
            ref_uid: self.ref_uid,
            status: self.status(now_secs()).to_string(),
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TierInfo {
    pub tier: Option<String>,
    pub staked: U128,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub governance: AccountId,
    pub schemas: AccountId,
    pub credentials: Option<AccountId>,
    pub staking: Option<AccountId>,
    pub attestation_count: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    /// Verifies authorities. Can be a DAO account.
    governance: AccountId,
    schemas_contract: AccountId,
    credentials: Option<AccountId>,
    staking: Option<AccountId>,
    schemas: LookupMap<Uid, SchemaInfo>,
    attestations: LookupMap<Uid, Attestation>,
    nonces: LookupMap<AccountId, u64>,
    authorities: LookupMap<AccountId, Authority>,
    tiers: LookupMap<AccountId, TierInfo>,
    delegates: LookupMap<(AccountId, AccountId), DelegateGrant>,
    delegate_lists: LookupMap<AccountId, Vec<AccountId>>,
    signer_keys: LookupMap<AccountId, Vec<[u8; 32]>>,
    used_nonces: LookupSet<(AccountId, [u8; 32])>,
    expiry_recorded: LookupSet<Uid>,
    multisigs: LookupMap<AccountId, Multisig>,
    multisig_count: u64,
    proposals: LookupMap<u64, Proposal>,
    proposal_count: u64,
    pending: LookupMap<u64, PendingOp>,
    op_count: u64,
    attestation_count: u64,
    ledger: StorageLedger,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, governance: AccountId, schemas: AccountId) -> Self {
        Self {
            owner,
            governance,
            schemas_contract: schemas,
            credentials: None,
            staking: None,
            schemas: LookupMap::new(Key::Schemas),
            attestations: LookupMap::new(Key::Attestations),
            nonces: LookupMap::new(Key::Nonces),
            authorities: LookupMap::new(Key::Authorities),
            tiers: LookupMap::new(Key::Tiers),
            delegates: LookupMap::new(Key::Delegates),
            delegate_lists: LookupMap::new(Key::DelegateLists),
            signer_keys: LookupMap::new(Key::SignerKeys),
            used_nonces: LookupSet::new(Key::UsedNonces),
            expiry_recorded: LookupSet::new(Key::ExpiryRecorded),
            multisigs: LookupMap::new(Key::Multisigs),
            multisig_count: 0,
            proposals: LookupMap::new(Key::Proposals),
            proposal_count: 0,
            pending: LookupMap::new(Key::Pending),
            op_count: 0,
            attestation_count: 0,
            ledger: StorageLedger::new(Key::Ledger),
        }
    }

    // ---------------------------------------------------------------- admin

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    #[payable]
    pub fn set_governance(&mut self, governance: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.governance = governance;
    }

    #[payable]
    pub fn set_credentials(&mut self, credentials: Option<AccountId>) {
        assert_one_yocto();
        self.assert_owner();
        self.credentials = credentials;
    }

    #[payable]
    pub fn set_staking(&mut self, staking: Option<AccountId>) {
        assert_one_yocto();
        self.assert_owner();
        self.staking = staking;
    }

    // ---------------------------------------------------------------- hooks

    /// Called by the schemas contract once a schema passed its resolver check.
    #[payable]
    pub fn sync_schema(&mut self, uid: Uid, info: SchemaInfo) {
        require!(env::predecessor_account_id() == self.schemas_contract, "only the schemas contract");
        require!(!self.schemas.contains_key(&uid), "schema already known");
        let before = env::storage_usage();
        self.schemas.insert(uid, info);
        self.schemas.flush();
        let cost = (env::storage_usage() - before) as u128 * env::storage_byte_cost().as_yoctonear();
        require!(env::attached_deposit().as_yoctonear() >= cost, "sync deposit does not cover storage");
    }

    /// Called by the staking contract whenever an account's stake changes.
    pub fn on_tier_changed(&mut self, account_id: AccountId, tier: Option<String>, staked: U128) {
        require!(Some(env::predecessor_account_id()) == self.staking, "only the staking contract");
        self.tiers.insert(account_id.clone(), TierInfo { tier: tier.clone(), staked });
        events::emit(
            events::AUTHORITY_TIER,
            &json!({ "account_id": account_id, "tier": tier, "staked": staked }),
        );
    }

    // ---------------------------------------------------------------- views

    pub fn get_attestation(&self, uid: Uid) -> Option<AttestationView> {
        self.attestations.get(&uid).map(|a| a.view(uid))
    }

    pub fn get_attestations(&self, uids: Vec<Uid>) -> Vec<Option<AttestationView>> {
        require!(uids.len() <= 100, "at most 100 uids");
        uids.into_iter().map(|u| self.get_attestation(u)).collect()
    }

    /// True when the attestation exists and is active right now.
    pub fn is_valid(&self, uid: Uid) -> bool {
        self.attestations.get(&uid).map(|a| a.status(now_secs()) == "active").unwrap_or(false)
    }

    pub fn get_schema_info(&self, uid: Uid) -> Option<SchemaInfo> {
        self.schemas.get(&uid).cloned()
    }

    pub fn get_nonce(&self, account_id: AccountId) -> u64 {
        self.nonces.get(&account_id).copied().unwrap_or(0)
    }

    pub fn get_tier(&self, account_id: AccountId) -> TierInfo {
        self.tiers.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn attestation_count(&self) -> u64 {
        self.attestation_count
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            governance: self.governance.clone(),
            schemas: self.schemas_contract.clone(),
            credentials: self.credentials.clone(),
            staking: self.staking.clone(),
            attestation_count: self.attestation_count,
        }
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    // ---------------------------------------------------------------- NEP-145

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let amount = env::attached_deposit().as_yoctonear();
        if registration_only.unwrap_or(false) && self.ledger.get(&account_id).is_some() {
            if amount > 0 {
                near_sdk::Promise::new(env::predecessor_account_id())
                    .transfer(NearToken::from_yoctonear(amount))
                    .detach();
            }
        } else {
            self.ledger.deposit(&account_id, amount);
        }
        self.ledger.balance_of(&account_id).expect("registered")
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        self.ledger.withdraw(&caller, amount.map(|a| a.0));
        self.ledger.balance_of(&caller).expect("registered")
    }

    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        require!(!force.unwrap_or(false), "force is not supported: attestations stay stored");
        self.ledger.unregister(&env::predecessor_account_id())
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.ledger.balance_of(&account_id)
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageLedger::bounds()
    }
}

impl Contract {
    /// Credits an attached deposit to `payer`'s storage balance.
    pub(crate) fn take_deposit(&mut self, payer: &AccountId) {
        self.ledger.deposit(payer, env::attached_deposit().as_yoctonear());
    }

    pub(crate) fn next_nonce(&mut self, attester: &AccountId) -> u64 {
        let n = self.nonces.get(attester).copied().unwrap_or(0);
        self.nonces.insert(attester.clone(), n + 1);
        n
    }
}

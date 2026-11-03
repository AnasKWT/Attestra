//! Attestra schema registry.
//!
//! A schema names the shape of a claim (`string name, u8 level, bool verified`), an optional
//! resolver that adds rules, and whether its attestations can be revoked. Its UID is derived from
//! those three inputs, so anyone can compute it before registering.
//!
//! Registration is a short promise chain: the schema is stored as pending, the resolver (if any)
//! is asked to accept it, the attestations contract is told about it, and only then does it
//! become active. If any step fails the schema is removed and its storage refunded.
//!
//! Large definitions are stored once as a content-addressed blob and referenced by hash.

use attestra_common::definition;
use attestra_common::events::{self, emit};
use attestra_common::resolver::{ext_attestations, ext_resolver, SchemaInfo};
use attestra_common::storage::{StorageBalance, StorageBalanceBounds, StorageLedger};
use attestra_common::uid::{schema_uid, Uid};
use attestra_common::{now_secs, promise_bool, promise_succeeded, MAX_BLOB_LEN, MAX_DEFINITION_LEN};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    PromiseOrValue,
};

/// Deposit forwarded with `sync_schema` to pay for the attestations contract's copy.
pub const SYNC_DEPOSIT: NearToken = NearToken::from_millinear(3);
const GAS_RESOLVER_CHECK: Gas = Gas::from_tgas(25);
const GAS_SYNC: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(25);
const MAX_PAGE: u64 = 50;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Schemas,
    Order,
    Blobs,
    Ledger,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SchemaStatus {
    Pending,
    Active,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub enum Definition {
    Inline(String),
    Blob(Uid),
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Schema {
    pub definition: Definition,
    pub authority: AccountId,
    pub resolver: Option<AccountId>,
    pub revocable: bool,
    pub created_at: u64,
    pub status: SchemaStatus,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SchemaView {
    pub uid: Uid,
    pub definition: String,
    pub authority: AccountId,
    pub resolver: Option<AccountId>,
    pub revocable: bool,
    pub created_at: u64,
    pub status: SchemaStatus,
    /// Set when the definition is stored as a blob (large schemas).
    pub blob_hash: Option<Uid>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub attestations: AccountId,
    pub sync_deposit: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    attestations: AccountId,
    schemas: LookupMap<Uid, Schema>,
    order: Vector<Uid>,
    blobs: LookupMap<Uid, String>,
    ledger: StorageLedger,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, attestations: AccountId) -> Self {
        Self {
            owner,
            attestations,
            schemas: LookupMap::new(Key::Schemas),
            order: Vector::new(Key::Order),
            blobs: LookupMap::new(Key::Blobs),
            ledger: StorageLedger::new(Key::Ledger),
        }
    }

    // ---------------------------------------------------------------- registration

    /// Registers a schema. Returns its UID, or null when the resolver or the attestations
    /// contract refused it (the storage is refunded). Attach a deposit or hold a storage balance.
    #[payable]
    pub fn register_schema(
        &mut self,
        definition: String,
        resolver: Option<AccountId>,
        revocable: bool,
    ) -> PromiseOrValue<Option<Uid>> {
        require!(definition.len() <= MAX_DEFINITION_LEN, "definition too long; store it as a blob first");
        self.register(Definition::Inline(definition), resolver, revocable)
    }

    /// Stores a large definition (or any text) once and returns its SHA-256 hash.
    #[payable]
    pub fn store_blob(&mut self, content: String) -> Uid {
        let caller = env::predecessor_account_id();
        self.ledger.deposit(&caller, env::attached_deposit().as_yoctonear());
        require!(!content.is_empty(), "blob is empty");
        require!(content.len() <= MAX_BLOB_LEN, format!("blob larger than {MAX_BLOB_LEN} bytes"));
        let hash = Uid::sha256(content.as_bytes());
        if !self.blobs.contains_key(&hash) {
            let before = env::storage_usage();
            let size = content.len();
            self.blobs.insert(hash, content);
            self.blobs.flush();
            self.ledger.settle(&caller, before, env::storage_usage());
            emit(events::BLOB_STORED, &json!({ "hash": hash, "size": size, "by": caller }));
        }
        hash
    }

    /// Registers a schema whose definition is a stored blob. The UID is the same as registering
    /// the same definition inline.
    #[payable]
    pub fn register_schema_from_blob(
        &mut self,
        blob_hash: Uid,
        resolver: Option<AccountId>,
        revocable: bool,
    ) -> PromiseOrValue<Option<Uid>> {
        require!(self.blobs.contains_key(&blob_hash), "unknown blob");
        self.register(Definition::Blob(blob_hash), resolver, revocable)
    }

    fn register(
        &mut self,
        definition: Definition,
        resolver: Option<AccountId>,
        revocable: bool,
    ) -> PromiseOrValue<Option<Uid>> {
        let authority = env::predecessor_account_id();
        self.ledger.deposit(&authority, env::attached_deposit().as_yoctonear());
        let text = self.definition_text(&definition);
        if let Err(e) = definition::parse(&text) {
            env::panic_str(&e);
        }
        if let Some(r) = &resolver {
            require!(r != &env::current_account_id(), "the registry cannot be a resolver");
        }
        let uid = schema_uid(&text, &resolver, revocable);
        require!(!self.schemas.contains_key(&uid), format!("schema {uid} already exists"));

        let before = env::storage_usage();
        let schema = Schema {
            definition,
            authority: authority.clone(),
            resolver: resolver.clone(),
            revocable,
            created_at: now_secs(),
            status: SchemaStatus::Pending,
        };
        self.schemas.insert(uid, schema);
        self.schemas.flush();
        self.ledger.settle(&authority, before, env::storage_usage());
        self.ledger.spend(&authority, SYNC_DEPOSIT.as_yoctonear());
        emit(
            events::SCHEMA_PENDING,
            &json!({ "uid": uid, "authority": authority, "resolver": resolver, "revocable": revocable }),
        );

        match resolver {
            Some(r) => ext_resolver::ext(r)
                .with_static_gas(GAS_RESOLVER_CHECK)
                .on_schema_registered(uid, authority)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK.saturating_add(GAS_SYNC).saturating_add(GAS_CALLBACK))
                        .on_resolver_checked(uid),
                )
                .into(),
            None => self.sync(uid).into(),
        }
    }

    fn sync(&self, uid: Uid) -> near_sdk::Promise {
        let s = self.schemas.get(&uid).expect("schema");
        let info = SchemaInfo {
            authority: s.authority.clone(),
            resolver: s.resolver.clone(),
            revocable: s.revocable,
        };
        ext_attestations::ext(self.attestations.clone())
            .with_static_gas(GAS_SYNC)
            .with_attached_deposit(SYNC_DEPOSIT)
            .sync_schema(uid, info)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_synced(uid))
    }

    #[private]
    pub fn on_resolver_checked(&mut self, uid: Uid) -> PromiseOrValue<Option<Uid>> {
        if promise_bool() {
            self.sync(uid).into()
        } else {
            // The sync deposit never left; put it back before removing the schema.
            self.rollback(uid, "the resolver refused the schema", true);
            PromiseOrValue::Value(None)
        }
    }

    #[private]
    pub fn on_synced(&mut self, uid: Uid) -> Option<Uid> {
        if !promise_succeeded() {
            // A failed call returns its deposit to this contract; credit it back to the authority.
            self.rollback(uid, "the attestations contract did not accept the schema", true);
            return None;
        }
        let schema = self.schemas.get_mut(&uid)?;
        schema.status = SchemaStatus::Active;
        let (authority, resolver, revocable) =
            (schema.authority.clone(), schema.resolver.clone(), schema.revocable);
        self.order.push(uid);
        self.order.flush();
        // The order entry is the registry's own bookkeeping; the authority's balance already
        // covered the schema itself.
        emit(
            events::SCHEMA_REGISTERED,
            &json!({ "uid": uid, "authority": authority, "resolver": resolver, "revocable": revocable }),
        );
        Some(uid)
    }

    fn rollback(&mut self, uid: Uid, reason: &str, refund_sync: bool) {
        let Some(schema) = self.schemas.get(&uid).cloned() else { return };
        let before = env::storage_usage();
        self.schemas.remove(&uid);
        self.schemas.flush();
        self.ledger.settle(&schema.authority, before, env::storage_usage());
        if refund_sync {
            self.ledger.refund(&schema.authority, SYNC_DEPOSIT.as_yoctonear());
        }
        emit(
            events::SCHEMA_REJECTED,
            &json!({ "uid": uid, "authority": schema.authority, "reason": reason }),
        );
    }

    fn definition_text(&self, definition: &Definition) -> String {
        match definition {
            Definition::Inline(s) => s.clone(),
            Definition::Blob(h) => {
                self.blobs.get(h).cloned().unwrap_or_else(|| env::panic_str("unknown blob"))
            }
        }
    }

    // ---------------------------------------------------------------- views

    pub fn get_schema(&self, uid: Uid) -> Option<SchemaView> {
        self.schemas.get(&uid).map(|s| self.view(uid, s))
    }

    pub fn get_blob(&self, hash: Uid) -> Option<String> {
        self.blobs.get(&hash).cloned()
    }

    pub fn schema_count(&self) -> u32 {
        self.order.len()
    }

    /// Active schemas in registration order.
    pub fn list_schemas(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<SchemaView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(20).min(MAX_PAGE as u32);
        (from..self.order.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.order.get(i).copied())
            .filter_map(|uid| self.schemas.get(&uid).map(|s| self.view(uid, s)))
            .collect()
    }

    pub fn compute_schema_uid(
        &self,
        definition: String,
        resolver: Option<AccountId>,
        revocable: bool,
    ) -> Uid {
        schema_uid(&definition, &resolver, revocable)
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            attestations: self.attestations.clone(),
            sync_deposit: U128(SYNC_DEPOSIT.as_yoctonear()),
        }
    }

    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    fn view(&self, uid: Uid, s: &Schema) -> SchemaView {
        let blob_hash = match &s.definition {
            Definition::Blob(h) => Some(*h),
            Definition::Inline(_) => None,
        };
        SchemaView {
            uid,
            definition: self.definition_text(&s.definition),
            authority: s.authority.clone(),
            resolver: s.resolver.clone(),
            revocable: s.revocable,
            created_at: s.created_at,
            status: s.status,
            blob_hash,
        }
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
        require!(!force.unwrap_or(false), "force is not supported: schemas stay registered");
        self.ledger.unregister(&env::predecessor_account_id())
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.ledger.balance_of(&account_id)
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageLedger::bounds()
    }
}

#[cfg(test)]
mod tests;

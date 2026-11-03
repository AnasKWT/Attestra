//! Authorities, delegates and signer keys.

use crate::*;
use attestra_common::events::emit;
use attestra_common::MAX_METADATA_LEN;
use near_sdk::PublicKey;

pub const AUTHORITY_KINDS: &[&str] = &["organization", "person", "agent", "multisig", "verifier", "other"];
const MAX_DELEGATES: usize = 50;
const MAX_SIGNER_KEYS: usize = 10;
const MAX_SCOPE_SCHEMAS: usize = 20;

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Authority {
    pub metadata: String,
    pub kind: String,
    pub verified: bool,
    pub registered_at: u64,
    pub verified_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AuthorityView {
    pub account_id: AccountId,
    pub metadata: String,
    pub kind: String,
    pub verified: bool,
    pub registered_at: u64,
    pub verified_at: u64,
    pub tier: Option<String>,
    pub staked: U128,
    pub delegate_count: u32,
}

/// What a delegate may do. Every field is optional: no schemas means any schema, no expiry
/// means until removed, no max_uses means unlimited.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct DelegateScope {
    pub schemas: Option<Vec<Uid>>,
    pub expires_at: Option<u64>,
    pub max_uses: Option<u32>,
    pub can_revoke: Option<bool>,
    pub label: Option<String>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct DelegateGrant {
    pub schemas: Option<Vec<Uid>>,
    pub expires_at: u64,
    pub max_uses: u32,
    pub uses: u32,
    pub can_revoke: bool,
    pub label: String,
    pub granted_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DelegateView {
    pub authority: AccountId,
    pub delegate: AccountId,
    pub schemas: Option<Vec<Uid>>,
    pub expires_at: u64,
    pub max_uses: u32,
    pub uses: u32,
    pub can_revoke: bool,
    pub label: String,
    pub granted_at: u64,
    pub active: bool,
}

impl DelegateGrant {
    fn active(&self, now: u64) -> bool {
        (self.expires_at == 0 || now < self.expires_at) && (self.max_uses == 0 || self.uses < self.max_uses)
    }

    fn view(&self, authority: &AccountId, delegate: &AccountId) -> DelegateView {
        DelegateView {
            authority: authority.clone(),
            delegate: delegate.clone(),
            schemas: self.schemas.clone(),
            expires_at: self.expires_at,
            max_uses: self.max_uses,
            uses: self.uses,
            can_revoke: self.can_revoke,
            label: self.label.clone(),
            granted_at: self.granted_at,
            active: self.active(now_secs()),
        }
    }
}

#[near]
impl Contract {
    /// Registers (or updates) the caller as an authority. Updating clears verification.
    #[payable]
    pub fn register_authority(&mut self, metadata: String, kind: Option<String>) {
        let caller = env::predecessor_account_id();
        require!(!caller.as_str().ends_with(&format!(".{}", env::current_account_id())), "reserved account");
        self.take_deposit(&caller);
        self.put_authority(&caller, metadata, kind.unwrap_or_else(|| "organization".into()));
    }

    /// Governance marks an authority verified (or not).
    pub fn set_authority_verification(&mut self, account_id: AccountId, verified: bool) {
        require!(env::predecessor_account_id() == self.governance, "only governance can verify authorities");
        let a =
            self.authorities.get_mut(&account_id).unwrap_or_else(|| env::panic_str("authority not found"));
        a.verified = verified;
        a.verified_at = if verified { now_secs() } else { 0 };
        emit(events::AUTHORITY_VERIFIED, &json!({ "account_id": account_id, "verified": verified }));
    }

    pub fn get_authority(&self, account_id: AccountId) -> Option<AuthorityView> {
        let a = self.authorities.get(&account_id)?;
        let tier = self.tiers.get(&account_id).cloned().unwrap_or_default();
        Some(AuthorityView {
            account_id: account_id.clone(),
            metadata: a.metadata.clone(),
            kind: a.kind.clone(),
            verified: a.verified,
            registered_at: a.registered_at,
            verified_at: a.verified_at,
            tier: tier.tier,
            staked: tier.staked,
            delegate_count: self.delegate_lists.get(&account_id).map(|l| l.len() as u32).unwrap_or(0),
        })
    }

    /// Lets `delegate` attest (and optionally revoke) for the caller within `scope`.
    /// Replaces an existing grant to the same delegate.
    #[payable]
    pub fn add_delegate(&mut self, delegate: AccountId, scope: Option<DelegateScope>) {
        let authority = env::predecessor_account_id();
        require!(delegate != authority, "an account cannot delegate to itself");
        self.take_deposit(&authority);
        let scope = scope.unwrap_or_default();
        if let Some(s) = &scope.schemas {
            require!(!s.is_empty() && s.len() <= MAX_SCOPE_SCHEMAS, "scope lists 1 to 20 schemas");
        }
        let expires_at = scope.expires_at.unwrap_or(0);
        require!(expires_at == 0 || expires_at > now_secs(), "expires_at must be in the future");
        let label = scope.label.clone().unwrap_or_default();
        require!(label.len() <= 128, "label too long");

        let before = env::storage_usage();
        let grant = DelegateGrant {
            schemas: scope.schemas.clone(),
            expires_at,
            max_uses: scope.max_uses.unwrap_or(0),
            uses: 0,
            can_revoke: scope.can_revoke.unwrap_or(false),
            label: label.clone(),
            granted_at: now_secs(),
        };
        self.delegates.insert((authority.clone(), delegate.clone()), grant);
        let mut list = self.delegate_lists.get(&authority).cloned().unwrap_or_default();
        if !list.contains(&delegate) {
            require!(list.len() < MAX_DELEGATES, "too many delegates");
            list.push(delegate.clone());
        }
        self.delegate_lists.insert(authority.clone(), list);
        self.delegates.flush();
        self.delegate_lists.flush();
        self.ledger.settle(&authority, before, env::storage_usage());
        emit(
            events::DELEGATE_ADDED,
            &json!({
                "authority": authority, "delegate": delegate, "schemas": scope.schemas, "expires_at": expires_at,
                "max_uses": scope.max_uses.unwrap_or(0), "can_revoke": scope.can_revoke.unwrap_or(false), "label": label,
            }),
        );
    }

    pub fn remove_delegate(&mut self, delegate: AccountId) {
        let authority = env::predecessor_account_id();
        let before = env::storage_usage();
        require!(
            self.delegates.remove(&(authority.clone(), delegate.clone())).is_some(),
            "delegate not found"
        );
        let mut list = self.delegate_lists.get(&authority).cloned().unwrap_or_default();
        list.retain(|d| d != &delegate);
        if list.is_empty() {
            self.delegate_lists.remove(&authority);
        } else {
            self.delegate_lists.insert(authority.clone(), list);
        }
        self.delegates.flush();
        self.delegate_lists.flush();
        self.ledger.settle(&authority, before, env::storage_usage());
        emit(events::DELEGATE_REMOVED, &json!({ "authority": authority, "delegate": delegate }));
    }

    /// True when `delegate` holds an active grant from `authority`.
    pub fn is_delegate(&self, authority: AccountId, delegate: AccountId) -> bool {
        self.delegates.get(&(authority, delegate)).map(|g| g.active(now_secs())).unwrap_or(false)
    }

    pub fn get_delegate(&self, authority: AccountId, delegate: AccountId) -> Option<DelegateView> {
        self.delegates.get(&(authority.clone(), delegate.clone())).map(|g| g.view(&authority, &delegate))
    }

    pub fn get_delegates(&self, authority: AccountId) -> Vec<DelegateView> {
        self.delegate_lists
            .get(&authority)
            .map(|list| {
                list.iter()
                    .filter_map(|d| {
                        self.delegates.get(&(authority.clone(), d.clone())).map(|g| g.view(&authority, d))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Registers an ed25519 key that may sign NEP-413 requests for the caller.
    #[payable]
    pub fn add_signer_key(&mut self, public_key: PublicKey) {
        let account = env::predecessor_account_id();
        self.take_deposit(&account);
        let key = ed25519_bytes(&public_key);
        let before = env::storage_usage();
        let mut keys = self.signer_keys.get(&account).cloned().unwrap_or_default();
        require!(!keys.contains(&key), "key already registered");
        require!(keys.len() < MAX_SIGNER_KEYS, "too many signer keys");
        keys.push(key);
        self.signer_keys.insert(account.clone(), keys);
        self.signer_keys.flush();
        self.ledger.settle(&account, before, env::storage_usage());
        emit(events::SIGNER_KEY_ADDED, &json!({ "account_id": account, "public_key": public_key }));
    }

    pub fn remove_signer_key(&mut self, public_key: PublicKey) {
        let account = env::predecessor_account_id();
        let key = ed25519_bytes(&public_key);
        let before = env::storage_usage();
        let mut keys = self.signer_keys.get(&account).cloned().unwrap_or_default();
        let len = keys.len();
        keys.retain(|k| k != &key);
        require!(keys.len() < len, "key not registered");
        if keys.is_empty() {
            self.signer_keys.remove(&account);
        } else {
            self.signer_keys.insert(account.clone(), keys);
        }
        self.signer_keys.flush();
        self.ledger.settle(&account, before, env::storage_usage());
        emit(events::SIGNER_KEY_REMOVED, &json!({ "account_id": account, "public_key": public_key }));
    }

    pub fn get_signer_keys(&self, account_id: AccountId) -> Vec<String> {
        self.signer_keys
            .get(&account_id)
            .map(|keys| {
                keys.iter().map(|k| format!("ed25519:{}", near_sdk::bs58::encode(k).into_string())).collect()
            })
            .unwrap_or_default()
    }
}

impl Contract {
    pub(crate) fn put_authority(&mut self, account: &AccountId, metadata: String, kind: String) {
        require!(metadata.len() <= MAX_METADATA_LEN, "metadata too long");
        require!(AUTHORITY_KINDS.contains(&kind.as_str()), "unknown authority kind");
        let before = env::storage_usage();
        let registered_at = self.authorities.get(account).map(|a| a.registered_at).unwrap_or_else(now_secs);
        self.authorities.insert(
            account.clone(),
            Authority {
                metadata: metadata.clone(),
                kind: kind.clone(),
                verified: false,
                registered_at,
                verified_at: 0,
            },
        );
        self.authorities.flush();
        let payer = env::predecessor_account_id();
        self.ledger.settle(&payer, before, env::storage_usage());
        emit(
            events::AUTHORITY_REGISTERED,
            &json!({ "account_id": account, "metadata": metadata, "kind": kind }),
        );
    }

    /// Checks and counts one use of a delegate grant.
    pub(crate) fn use_grant(
        &mut self,
        authority: &AccountId,
        delegate: &AccountId,
        schema: Option<Uid>,
        revoke: bool,
    ) {
        let now = now_secs();
        let grant = self
            .delegates
            .get_mut(&(authority.clone(), delegate.clone()))
            .unwrap_or_else(|| env::panic_str("not a delegate of this authority"));
        require!(grant.expires_at == 0 || now < grant.expires_at, "the delegation expired");
        require!(grant.max_uses == 0 || grant.uses < grant.max_uses, "the delegation has no uses left");
        if let (Some(scope), Some(s)) = (&grant.schemas, schema) {
            require!(scope.contains(&s), "the schema is outside the delegation's scope");
        }
        if revoke {
            require!(grant.can_revoke, "the delegation does not allow revoking");
        }
        grant.uses += 1;
    }

    /// A registered signer key, or the key an implicit account id (64 hex chars) is made of.
    pub(crate) fn signer_allowed(&self, account: &AccountId, key: &[u8; 32]) -> bool {
        if self.signer_keys.get(account).map(|keys| keys.contains(key)).unwrap_or(false) {
            return true;
        }
        let id = account.as_str();
        id.len() == 64 && hex::encode(key) == id
    }
}

fn ed25519_bytes(public_key: &PublicKey) -> [u8; 32] {
    let b = public_key.as_bytes();
    require!(b.len() == 33 && b[0] == 0, "only ed25519 keys are supported");
    b[1..].try_into().expect("33 bytes")
}

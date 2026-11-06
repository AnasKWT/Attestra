//! Whitelist: an attestation passes only when its attester is whitelisted for the schema.

use crate::*;
use near_sdk::log;

#[near]
impl Contract {
    #[payable]
    pub fn whitelist_add(&mut self, schema_uid: Uid, account_id: AccountId) {
        self.require_kind(ResolverKind::Whitelist);
        self.assert_admin(&schema_uid);
        let before = env::storage_usage();
        let added = self.whitelist.insert((schema_uid, account_id.clone()));
        settle_deposit(before);
        if added {
            self.configured(Some(&schema_uid), "whitelist_added", json!(account_id));
        }
    }

    #[payable]
    pub fn whitelist_remove(&mut self, schema_uid: Uid, account_id: AccountId) {
        self.require_kind(ResolverKind::Whitelist);
        self.assert_admin(&schema_uid);
        let removed = self.whitelist.remove(&(schema_uid, account_id.clone()));
        refund(&env::predecessor_account_id(), env::attached_deposit().as_yoctonear());
        if removed {
            self.configured(Some(&schema_uid), "whitelist_removed", json!(account_id));
        }
    }

    pub fn is_whitelisted(&self, schema_uid: Uid, account_id: AccountId) -> bool {
        self.require_kind(ResolverKind::Whitelist);
        self.whitelist.contains(&(schema_uid, account_id))
    }
}

impl Contract {
    pub(crate) fn whitelist_allows(&self, call: &ResolverCall) -> bool {
        let allowed = self.whitelist.contains(&(call.schema_uid, call.attester.clone()));
        if !allowed {
            log!("{} is not whitelisted for schema {}", call.attester, call.schema_uid);
        }
        allowed
    }
}

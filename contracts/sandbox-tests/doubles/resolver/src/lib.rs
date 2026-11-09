//! Test double of a schema resolver, for the sandbox tests only.
//!
//! Its owner sets what it answers to `on_schema_registered`, `on_attest` and `on_revoke`, so the
//! tests can make a resolver refuse cleanly (return false) where the real resolvers never do.
//! `on_aborted` and `on_committed` only count calls.

use near_sdk::serde_json::Value;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Answers {
    pub schema: bool,
    pub attest: bool,
    pub revoke: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Counts {
    pub aborted: u32,
    pub committed: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    schema: bool,
    attest: bool,
    revoke: bool,
    aborted: u32,
    committed: u32,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, answers: Answers) -> Self {
        Self {
            owner,
            schema: answers.schema,
            attest: answers.attest,
            revoke: answers.revoke,
            aborted: 0,
            committed: 0,
        }
    }

    /// Owner only: what the hooks answer from now on.
    pub fn set_answers(&mut self, answers: Answers) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        self.schema = answers.schema;
        self.attest = answers.attest;
        self.revoke = answers.revoke;
    }

    pub fn get_answers(&self) -> Answers {
        Answers { schema: self.schema, attest: self.attest, revoke: self.revoke }
    }

    pub fn get_counts(&self) -> Counts {
        Counts { aborted: self.aborted, committed: self.committed }
    }

    pub fn on_schema_registered(&mut self, schema_uid: String, authority: AccountId) -> bool {
        let _ = (schema_uid, authority);
        self.schema
    }

    pub fn on_attest(&mut self, call: Value) -> bool {
        let _ = call;
        self.attest
    }

    pub fn on_revoke(&mut self, call: Value) -> bool {
        let _ = call;
        self.revoke
    }

    pub fn on_aborted(&mut self, call: Value) {
        let _ = call;
        self.aborted += 1;
    }

    pub fn on_committed(&mut self, call: Value) {
        let _ = call;
        self.committed += 1;
    }
}

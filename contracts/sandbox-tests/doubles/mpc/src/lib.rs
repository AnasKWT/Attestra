//! Test double of the NEAR MPC contract, for the sandbox tests only.
//!
//! `verify_foreign_transaction` answers at once (the real contract answers later through
//! yield/resume) with the response the test set beforehand: a `VerifyForeignTransactionResponse`
//! the test signed off chain with a known secp256k1 key. With no response set, the call fails like
//! a timed out request. The double records the last request and deposit so the test can check what
//! the verdicts contract asked for.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    /// The JSON the next call returns; None makes the call fail.
    response: Option<String>,
    last_request: Option<String>,
    last_deposit: u128,
    calls: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, response: None, last_request: None, last_deposit: 0, calls: 0 }
    }

    /// Owner only: the response of the following calls, or None to make them fail.
    pub fn set_response(&mut self, response: Option<Value>) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        self.response = response.map(|r| r.to_string());
    }

    #[payable]
    pub fn verify_foreign_transaction(&mut self, request: Value) -> Value {
        let Some(response) = self.response.clone() else {
            env::panic_str("the MPC double has no response configured");
        };
        self.last_request = Some(request.to_string());
        self.last_deposit = env::attached_deposit().as_yoctonear();
        self.calls += 1;
        serde_json::from_str(&response).expect("stored as JSON")
    }

    pub fn last_request(&self) -> Option<Value> {
        self.last_request.as_ref().map(|r| serde_json::from_str(r).expect("stored as JSON"))
    }

    pub fn last_deposit(&self) -> U128 {
        U128(self.last_deposit)
    }

    pub fn call_count(&self) -> u64 {
        self.calls
    }
}

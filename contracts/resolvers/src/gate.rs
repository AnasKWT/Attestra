//! Token gated: an attestation passes only when the attester holds at least `min_balance` of the
//! schema's NEP-141 token, read with `ft_balance_of` at attest time.

use crate::*;
use near_sdk::{log, serde_json};

/// Longest JSON a `U128` balance can take (`"340282366920938463463374607431768211455"`).
const MAX_BALANCE_JSON: usize = 64;

#[near(serializers = [borsh])]
pub(crate) struct Gate {
    pub token: AccountId,
    pub min_balance: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateView {
    pub token: AccountId,
    pub min_balance: U128,
}

#[near]
impl Contract {
    #[payable]
    pub fn set_gate(&mut self, schema_uid: Uid, token: AccountId, min_balance: U128) {
        self.require_kind(ResolverKind::TokenGated);
        self.assert_admin(&schema_uid);
        let before = env::storage_usage();
        self.gates.insert(schema_uid, Gate { token: token.clone(), min_balance: min_balance.0 });
        self.gates.flush();
        settle_deposit(before);
        self.configured(Some(&schema_uid), "gate", json!({ "token": token, "min_balance": min_balance }));
    }

    pub fn get_gate(&self, schema_uid: Uid) -> Option<GateView> {
        self.require_kind(ResolverKind::TokenGated);
        self.gates
            .get(&schema_uid)
            .map(|g| GateView { token: g.token.clone(), min_balance: U128(g.min_balance) })
    }

    /// True when `ft_balance_of` succeeded and returned at least `min_balance`.
    #[private]
    pub fn gate_checked(&self, min_balance: U128) -> bool {
        if env::promise_results_count() != 1 {
            return false;
        }
        let balance = env::promise_result_checked(0, MAX_BALANCE_JSON)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<U128>(&bytes).ok());
        match balance {
            Some(balance) if balance.0 >= min_balance.0 => true,
            Some(balance) => {
                log!("token balance {} is below the minimum {}", balance.0, min_balance.0);
                false
            }
            None => {
                log!("the token balance could not be read");
                false
            }
        }
    }
}

impl Contract {
    pub(crate) fn check_gate(&self, call: &ResolverCall) -> PromiseOrValue<bool> {
        let Some(gate) = self.gates.get(&call.schema_uid) else { return PromiseOrValue::Value(true) };
        let balance = ext_ft_core::ext(gate.token.clone())
            .with_static_gas(GAS_FT_VIEW)
            .with_unused_gas_weight(0)
            .ft_balance_of(call.attester.clone());
        let check = Contract::ext(env::current_account_id())
            .with_static_gas(GAS_FT_VIEW)
            .with_unused_gas_weight(0)
            .gate_checked(U128(gate.min_balance));
        PromiseOrValue::Promise(balance.then(check))
    }
}

//! Attestra staking: accounts stake one NEP-141 token (`ft_transfer_call` with the message
//! `""` or `"stake"`) to reach authority tiers. The tier is the highest one whose minimum the
//! stake reaches. Every change logs `stake_changed` and pushes the new tier and stake to the
//! attestations contract (`on_tier_changed`), so authority records always show the current tier.
//!
//! This contract pays the storage of stake entries itself: one small entry per staker, created
//! only by real transfers of the staking token, and removed when the stake drops to zero.

#[cfg(test)]
mod tests;

use attestra_common::events::{emit, STAKE_CHANGED};
use attestra_common::promise_succeeded;
use attestra_common::resolver::ext_attestations;
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise,
};

/// One whole token with 18 decimals.
const WHOLE: u128 = 1_000_000_000_000_000_000;
const MAX_TIERS: usize = 16;
const MAX_TIER_NAME_LEN: usize = 32;
/// `on_tier_changed` on the attestations contract.
const GAS_TIER_CHANGED: Gas = Gas::from_tgas(10);
/// `ft_transfer` on the staking token.
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
/// `unstake_settled`, which may restore the stake and push the tier again.
const GAS_UNSTAKE_CALLBACK: Gas = Gas::from_tgas(20);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tier {
    pub name: String,
    pub min: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StakeView {
    pub staked: U128,
    pub tier: Option<String>,
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Stakes,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    token: AccountId,
    attestations: AccountId,
    /// Sorted ascending by `min`.
    tiers: Vec<Tier>,
    stakes: LookupMap<AccountId, u128>,
    total_staked: u128,
}

/// Bronze 100, Silver 1,000 and Gold 10,000 whole tokens.
pub fn default_tiers() -> Vec<Tier> {
    [("Bronze", 100), ("Silver", 1_000), ("Gold", 10_000)]
        .into_iter()
        .map(|(name, whole)| Tier { name: name.to_string(), min: U128(whole * WHOLE) })
        .collect()
}

#[near]
impl Contract {
    /// `tiers` must be sorted ascending by `min`, with distinct names and positive, distinct
    /// minimums. An empty list uses `default_tiers()`.
    #[init]
    pub fn new(owner: AccountId, token: AccountId, attestations: AccountId, tiers: Vec<Tier>) -> Self {
        let tiers = if tiers.is_empty() { default_tiers() } else { tiers };
        validate_tiers(&tiers);
        Self { owner, token, attestations, tiers, stakes: LookupMap::new(Key::Stakes), total_staked: 0 }
    }

    /// NEP-141 receiver for the staking token: `""` or `"stake"` adds `amount` to the sender's
    /// stake; any other message returns the tokens.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(env::predecessor_account_id() == self.token, "only the staking token can be staked");
        if !(msg.is_empty() || msg == "stake") {
            log!("unknown message {msg:?}; returning the tokens");
            return amount;
        }
        if amount.0 == 0 {
            return U128(0);
        }
        let staked = self
            .stake_of(&sender_id)
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("stake overflow"));
        self.set_stake(&sender_id, staked);
        self.total_staked += amount.0;
        self.changed(&sender_id, "stake", amount, staked);
        U128(0)
    }

    /// Sends `amount` of the caller's stake back. Requires exactly 1 yoctoNEAR. Resolves to the
    /// amount sent; a failed transfer restores the stake and resolves to 0.
    #[payable]
    pub fn unstake(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let staked = self.stake_of(&account_id);
        require!(amount.0 > 0, "amount must be positive");
        require!(amount.0 <= staked, "amount exceeds the stake");
        let left = staked - amount.0;
        self.set_stake(&account_id, left);
        self.total_staked -= amount.0;
        self.changed(&account_id, "unstake", amount, left);
        ext_ft_core::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(account_id.clone(), amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_UNSTAKE_CALLBACK)
                    .with_unused_gas_weight(0)
                    .unstake_settled(account_id, amount),
            )
    }

    #[private]
    pub fn unstake_settled(&mut self, account_id: AccountId, amount: U128) -> U128 {
        if promise_succeeded() {
            return amount;
        }
        let staked = self.stake_of(&account_id).saturating_add(amount.0);
        self.set_stake(&account_id, staked);
        self.total_staked = self.total_staked.saturating_add(amount.0);
        log!("sending {} to {account_id} failed; the stake was restored", amount.0);
        self.changed(&account_id, "unstake_failed", amount, staked);
        U128(0)
    }

    pub fn get_stake(&self, account_id: AccountId) -> StakeView {
        let staked = self.stake_of(&account_id);
        StakeView { staked: U128(staked), tier: self.tier_for(staked) }
    }

    pub fn get_tiers(&self) -> Vec<Tier> {
        self.tiers.clone()
    }

    pub fn total_staked(&self) -> U128 {
        U128(self.total_staked)
    }
}

impl Contract {
    fn stake_of(&self, account_id: &AccountId) -> u128 {
        self.stakes.get(account_id).copied().unwrap_or(0)
    }

    fn set_stake(&mut self, account_id: &AccountId, staked: u128) {
        if staked == 0 {
            self.stakes.remove(account_id);
        } else {
            self.stakes.insert(account_id.clone(), staked);
        }
    }

    /// The highest tier whose minimum `staked` reaches.
    fn tier_for(&self, staked: u128) -> Option<String> {
        self.tiers.iter().rev().find(|t| t.min.0 <= staked).map(|t| t.name.clone())
    }

    /// Logs `stake_changed` and pushes the tier to the attestations contract.
    fn changed(&self, account_id: &AccountId, action: &str, amount: U128, staked: u128) {
        let tier = self.tier_for(staked);
        emit(
            STAKE_CHANGED,
            &json!({
                "account_id": account_id,
                "action": action,
                "amount": amount,
                "staked": U128(staked),
                "tier": tier,
                "total_staked": U128(self.total_staked),
            }),
        );
        ext_attestations::ext(self.attestations.clone())
            .with_static_gas(GAS_TIER_CHANGED)
            .with_unused_gas_weight(0)
            .on_tier_changed(account_id.clone(), tier, U128(staked))
            .detach();
    }
}

fn validate_tiers(tiers: &[Tier]) {
    require!(tiers.len() <= MAX_TIERS, format!("at most {MAX_TIERS} tiers"));
    for (i, tier) in tiers.iter().enumerate() {
        require!(
            !tier.name.is_empty() && tier.name.len() <= MAX_TIER_NAME_LEN,
            format!("tier names have 1 to {MAX_TIER_NAME_LEN} bytes")
        );
        require!(tier.min.0 > 0, "tier minimums must be positive");
        require!(!tiers[..i].iter().any(|t| t.name == tier.name), "tier names must be distinct");
        if i > 0 {
            require!(tiers[i - 1].min.0 < tier.min.0, "tiers must be sorted ascending by min, without ties");
        }
    }
}

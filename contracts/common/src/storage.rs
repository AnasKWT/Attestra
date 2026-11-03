//! NEP-145 storage accounting shared by the schemas and attestations contracts.
//!
//! Every account has an `available` balance (deposited, not yet used) and a `locked` balance
//! (paying for bytes it stored). A write measures the contract's storage before and after and
//! moves the difference between the two. Attached deposits top up `available` first, so a call
//! can either pay as it goes or spend a balance deposited earlier (by the account itself, or by
//! anyone else for it, such as the relayer for a gasless issuer). Freed bytes return to
//! `available`.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, IntoStorageKey, NearToken, Promise};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StorageAccount {
    pub available: u128,
    pub locked: u128,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

/// Bytes a ledger entry costs; the first deposit pays for it.
pub const ENTRY_BYTES: u64 = 160;

#[near(serializers = [borsh])]
pub struct StorageLedger {
    accounts: LookupMap<AccountId, StorageAccount>,
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Unused,
}

pub fn byte_cost() -> u128 {
    env::storage_byte_cost().as_yoctonear()
}

pub fn min_deposit() -> u128 {
    ENTRY_BYTES as u128 * byte_cost()
}

impl StorageLedger {
    pub fn new<S: IntoStorageKey>(prefix: S) -> Self {
        let _ = Key::Unused;
        Self { accounts: LookupMap::new(prefix) }
    }

    pub fn get(&self, account_id: &AccountId) -> Option<StorageAccount> {
        self.accounts.get(account_id).copied()
    }

    pub fn balance_of(&self, account_id: &AccountId) -> Option<StorageBalance> {
        self.get(account_id)
            .map(|a| StorageBalance { total: U128(a.available + a.locked), available: U128(a.available) })
    }

    pub fn bounds() -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(min_deposit()), max: None }
    }

    /// Adds `amount` to `account_id`'s available balance, registering it first if needed (the
    /// registration is paid from `amount`).
    pub fn deposit(&mut self, account_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        match self.accounts.get_mut(account_id) {
            Some(a) => a.available += amount,
            None => {
                require!(amount >= min_deposit(), "deposit below the storage registration minimum");
                let lock = min_deposit();
                self.accounts
                    .insert(account_id.clone(), StorageAccount { available: amount - lock, locked: lock });
            }
        }
    }

    /// Moves the storage delta of a write to or from `payer`. Panics when `payer` cannot cover new
    /// bytes, which reverts the whole call.
    pub fn settle(&mut self, payer: &AccountId, before: u64, after: u64) {
        if after == before {
            return;
        }
        let account = self.accounts.get_mut(payer);
        if after > before {
            let cost = (after - before) as u128 * byte_cost();
            let Some(a) = account else {
                env::panic_str(&format!(
                    "{payer} has no storage balance; call storage_deposit or attach {} yoctoNEAR",
                    cost + min_deposit()
                ));
            };
            require!(
                a.available >= cost,
                format!("storage balance too low: need {cost} yoctoNEAR, have {}", a.available)
            );
            a.available -= cost;
            a.locked += cost;
        } else if let Some(a) = account {
            let freed = ((before - after) as u128 * byte_cost()).min(a.locked);
            a.locked -= freed;
            a.available += freed;
        }
    }

    /// Takes `amount` out of `account_id`'s available balance so the contract can forward it (for
    /// example as the deposit of a cross-contract call that stores data elsewhere).
    pub fn spend(&mut self, account_id: &AccountId, amount: u128) {
        let a = self.accounts.get_mut(account_id).unwrap_or_else(|| env::panic_str("not registered"));
        require!(
            a.available >= amount,
            format!("storage balance too low: need {amount} yoctoNEAR, have {}", a.available)
        );
        a.available -= amount;
    }

    /// Puts `amount` back into `account_id`'s available balance (a forwarded deposit that came back).
    pub fn refund(&mut self, account_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        match self.accounts.get_mut(account_id) {
            Some(a) => a.available += amount,
            None => Promise::new(account_id.clone()).transfer(NearToken::from_yoctonear(amount)).detach(),
        }
    }

    /// Withdraws up to `amount` (all available when None) and returns the amount sent.
    pub fn withdraw(&mut self, account_id: &AccountId, amount: Option<u128>) -> u128 {
        let a = self.accounts.get_mut(account_id).unwrap_or_else(|| env::panic_str("not registered"));
        let amount = amount.unwrap_or(a.available);
        require!(amount <= a.available, "amount exceeds the available storage balance");
        a.available -= amount;
        if amount > 0 {
            Promise::new(account_id.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
        }
        amount
    }

    /// Removes the account when it locks nothing beyond its registration, refunding everything.
    pub fn unregister(&mut self, account_id: &AccountId) -> bool {
        let Some(a) = self.get(account_id) else { return false };
        require!(a.locked <= min_deposit(), "the account still pays for stored data");
        self.accounts.remove(account_id);
        let refund = a.available + a.locked;
        if refund > 0 {
            Promise::new(account_id.clone()).transfer(NearToken::from_yoctonear(refund)).detach();
        }
        true
    }
}

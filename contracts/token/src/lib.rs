//! Attestra test token (tATT): an NEP-141 token with NEP-145 storage and an hourly faucet, for
//! testnet only. It feeds the fee, token gated, token reward and staking flows.
//!
//! `faucet` mints 1,000 tokens to the caller once an hour and `mint` lets the owner mint any
//! amount. Both register the receiver at this contract's expense when needed. An account
//! registered that way gets no storage refund when it unregisters (only the 1 yoctoNEAR it
//! attached), so the faucet cannot be used to drain the contract's NEAR.

#[cfg(test)]
mod tests;

use attestra_common::now_secs;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    assert_one_yocto, env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault,
    Promise, PromiseOrValue,
};

/// 1,000 tokens with 18 decimals.
pub const FAUCET_AMOUNT: u128 = 1_000 * 1_000_000_000_000_000_000;
/// One faucet claim per account per hour.
pub const FAUCET_COOLDOWN_SECS: u64 = 3_600;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Accounts,
    LastClaim,
    Sponsored,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    /// Seconds of each account's last faucet claim.
    last_claim: LookupMap<AccountId, u64>,
    /// Accounts whose registration this contract paid.
    sponsored: LookupSet<AccountId>,
}

#[near]
impl Contract {
    /// Registers `owner` and mints `total_supply` to it.
    #[init]
    pub fn new(owner: AccountId, total_supply: U128) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Attestra Test Token".to_string(),
            symbol: "tATT".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 18,
        };
        metadata.assert_valid();
        let mut this = Self {
            owner: owner.clone(),
            token: FungibleToken::new(Key::Accounts),
            metadata,
            last_claim: LookupMap::new(Key::LastClaim),
            sponsored: LookupSet::new(Key::Sponsored),
        };
        this.token.internal_register_account(&owner);
        if total_supply.0 > 0 {
            this.token.internal_deposit(&owner, total_supply.0);
            FtMint { owner_id: &owner, amount: total_supply, memo: Some("initial supply") }.emit();
        }
        this
    }

    /// Mints 1,000 tokens to the caller, at most once an hour per account. Returns the amount.
    pub fn faucet(&mut self) -> U128 {
        let account_id = env::predecessor_account_id();
        let now = now_secs();
        if let Some(last) = self.last_claim.get(&account_id) {
            let next = last.saturating_add(FAUCET_COOLDOWN_SECS);
            require!(
                now >= next,
                format!("the faucet can be used once an hour; try again in {} seconds", next - now)
            );
        }
        self.last_claim.insert(account_id.clone(), now);
        self.mint_to(&account_id, FAUCET_AMOUNT, "faucet");
        U128(FAUCET_AMOUNT)
    }

    /// Owner only: mints `amount` to `account_id`.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can mint");
        require!(amount.0 > 0, "amount must be positive");
        self.mint_to(&account_id, amount.0, "mint");
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            log!("{sender_id} unregistered during the transfer; {burned} tokens were burned");
        }
        U128(used)
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    /// Unregisters the caller (with `force`, burning its balance). Accounts that paid their own
    /// registration get it back; accounts this contract registered get back only the 1
    /// yoctoNEAR they attached.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let Some(balance) = self.token.accounts.get(&account_id) else {
            log!("{account_id} is not registered");
            return false;
        };
        require!(
            balance == 0 || force.unwrap_or(false),
            "Can't unregister the account with the positive balance without force"
        );
        self.token.accounts.remove(&account_id);
        self.token.total_supply -= balance;
        if balance > 0 {
            FtBurn { owner_id: &account_id, amount: U128(balance), memo: Some("unregister") }.emit();
        }
        let one = NearToken::from_yoctonear(1);
        let refund = if self.sponsored.remove(&account_id) {
            one
        } else {
            self.token.storage_balance_bounds().min.saturating_add(one)
        };
        Promise::new(account_id).transfer(refund).detach();
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

impl Contract {
    /// Registers `account_id` at this contract's expense when needed, then mints to it.
    fn mint_to(&mut self, account_id: &AccountId, amount: u128, memo: &str) {
        if !self.token.accounts.contains_key(account_id) {
            self.token.internal_register_account(account_id);
            self.sponsored.insert(account_id.clone());
        }
        self.token.internal_deposit(account_id, amount);
        FtMint { owner_id: account_id, amount: U128(amount), memo: Some(memo) }.emit();
    }
}

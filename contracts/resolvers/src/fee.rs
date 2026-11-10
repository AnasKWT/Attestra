//! Fee: each schema can charge a fee in NEAR or one NEP-141 token from the owner's list of accepted
//! fee tokens. Payers keep a prepaid balance
//! here (`deposit` for NEAR, `ft_transfer_call` for tokens), so no funds travel with the resolver
//! call. `on_attest` moves the fee from the attester's balance into a charge held for the
//! attestation; `on_committed` adds it to the schema's collected fees and `on_aborted` returns it
//! to the payer. Holding the charge until commit keeps an abort refundable even after the admin
//! withdrew the fees collected so far.

use crate::*;
use attestra_common::events::{FEES_CLAIMED, FEE_CHARGED, FEE_DEPOSITED, FEE_REFUNDED, FEE_WITHDRAWN};
use attestra_common::promise_succeeded;
use near_sdk::{assert_one_yocto, log};

#[near(serializers = [borsh])]
pub(crate) struct Fee {
    pub token: Option<AccountId>,
    pub amount: u128,
}

#[near(serializers = [borsh])]
pub(crate) struct Charge {
    pub payer: AccountId,
    pub schema_uid: Uid,
    pub token: Option<AccountId>,
    pub amount: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeeView {
    /// None means NEAR.
    pub token: Option<AccountId>,
    pub amount: U128,
}

#[near]
impl Contract {
    /// Owner only, 1 yoctoNEAR: accepts `token` for fees and prepaid balances.
    #[payable]
    pub fn add_fee_token(&mut self, token: AccountId) {
        assert_one_yocto();
        self.require_kind(ResolverKind::Fee);
        self.assert_owner();
        if !self.fee_tokens.contains(&token) {
            self.fee_tokens.push(token.clone());
            self.configured(None, "fee_token_added", json!(token));
        }
    }

    /// Owner only, 1 yoctoNEAR: stops accepting new deposits of `token` and new fees in it.
    /// Balances already held stay withdrawable and fees already set keep charging.
    #[payable]
    pub fn remove_fee_token(&mut self, token: AccountId) {
        assert_one_yocto();
        self.require_kind(ResolverKind::Fee);
        self.assert_owner();
        if let Some(i) = self.fee_tokens.iter().position(|t| *t == token) {
            self.fee_tokens.remove(i);
            self.configured(None, "fee_token_removed", json!(token));
        }
    }

    pub fn fee_tokens(&self) -> Vec<AccountId> {
        self.require_kind(ResolverKind::Fee);
        self.fee_tokens.clone()
    }

    /// Sets the fee for attesting under `schema_uid`; `token` None means NEAR, otherwise it must
    /// be an accepted fee token. A zero amount charges nothing.
    #[payable]
    pub fn set_fee(&mut self, schema_uid: Uid, token: Option<AccountId>, amount: U128) {
        self.require_kind(ResolverKind::Fee);
        self.assert_admin(&schema_uid);
        if let Some(t) = &token {
            require!(self.fee_tokens.contains(t), format!("{t} is not an accepted fee token"));
        }
        let before = env::storage_usage();
        self.fees.insert(schema_uid, Fee { token: token.clone(), amount: amount.0 });
        self.fees.flush();
        settle_deposit(before);
        self.configured(Some(&schema_uid), "fee", json!({ "token": token, "amount": amount }));
    }

    pub fn get_fee(&self, schema_uid: Uid) -> Option<FeeView> {
        self.require_kind(ResolverKind::Fee);
        self.fees.get(&schema_uid).map(|f| FeeView { token: f.token.clone(), amount: U128(f.amount) })
    }

    /// Credits the attached NEAR to the caller's prepaid balance and returns the new balance.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        self.require_kind(ResolverKind::Fee);
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach the NEAR to deposit");
        U128(self.credit_balance(&env::predecessor_account_id(), &None, amount))
    }

    pub fn balance_of(&self, account_id: AccountId, token: Option<AccountId>) -> U128 {
        self.require_kind(ResolverKind::Fee);
        U128(self.balance(&account_id, &token))
    }

    /// Sends unused prepaid balance back to the caller (all of it when `amount` is None).
    /// Resolves to the amount sent; a failed transfer restores the balance and resolves to 0.
    pub fn withdraw_balance(&mut self, token: Option<AccountId>, amount: Option<U128>) -> Promise {
        self.require_kind(ResolverKind::Fee);
        let account_id = env::predecessor_account_id();
        let balance = self.balance(&account_id, &token);
        let amount = amount.map_or(balance, |a| a.0);
        require!(amount > 0, "nothing to withdraw");
        require!(amount <= balance, "amount exceeds the prepaid balance");
        self.set_balance(&account_id, &token, balance - amount);
        send(&account_id, &token, amount).then(this(GAS_CALLBACK).balance_withdrawn(
            account_id.clone(),
            token,
            U128(amount),
        ))
    }

    #[private]
    pub fn balance_withdrawn(
        &mut self,
        account_id: AccountId,
        token: Option<AccountId>,
        amount: U128,
    ) -> U128 {
        if promise_succeeded() {
            let balance = U128(self.balance(&account_id, &token));
            emit(
                FEE_WITHDRAWN,
                &json!({ "account_id": account_id, "token": token, "amount": amount, "balance": balance }),
            );
            amount
        } else {
            let balance = self.balance(&account_id, &token).saturating_add(amount.0);
            self.set_balance(&account_id, &token, balance);
            log!("withdrawal of {} to {account_id} failed; the balance was restored", amount.0);
            U128(0)
        }
    }

    /// Committed fees for `schema_uid` in `token` that the admin has not withdrawn yet.
    pub fn collected(&self, schema_uid: Uid, token: Option<AccountId>) -> U128 {
        self.require_kind(ResolverKind::Fee);
        U128(self.collected.get(&(schema_uid, token)).copied().unwrap_or(0))
    }

    /// Sends the fees collected for `schema_uid` in `token` to the schema admin. Resolves to the
    /// amount sent; a failed transfer restores the collected amount and resolves to 0.
    pub fn withdraw_fees(&mut self, schema_uid: Uid, token: Option<AccountId>) -> Promise {
        self.require_kind(ResolverKind::Fee);
        let admin = self.assert_admin(&schema_uid);
        let amount = self.collected.remove(&(schema_uid, token.clone())).unwrap_or(0);
        require!(amount > 0, "no fees collected");
        send(&admin, &token, amount).then(this(GAS_CALLBACK).fees_withdrawn(
            schema_uid,
            token,
            admin.clone(),
            U128(amount),
        ))
    }

    #[private]
    pub fn fees_withdrawn(
        &mut self,
        schema_uid: Uid,
        token: Option<AccountId>,
        admin: AccountId,
        amount: U128,
    ) -> U128 {
        if promise_succeeded() {
            emit(
                FEES_CLAIMED,
                &json!({ "schema_uid": schema_uid, "token": token, "admin": admin, "amount": amount }),
            );
            amount
        } else {
            let key = (schema_uid, token);
            let total = self.collected.get(&key).copied().unwrap_or(0).saturating_add(amount.0);
            self.collected.insert(key, total);
            log!("sending {} collected fees to {admin} failed; they were restored", amount.0);
            U128(0)
        }
    }
}

impl Contract {
    pub(crate) fn fee_on_transfer(
        &mut self,
        token: AccountId,
        sender_id: AccountId,
        amount: u128,
        msg: &str,
    ) -> U128 {
        if !self.fee_tokens.contains(&token) {
            log!("{token} is not an accepted fee token; returning the tokens");
            return U128(amount);
        }
        if !(msg.is_empty() || msg == "deposit") {
            log!("unknown message {msg:?}; returning the tokens");
            return U128(amount);
        }
        if amount > 0 {
            self.credit_balance(&sender_id, &Some(token), amount);
        }
        U128(0)
    }

    pub(crate) fn charge_fee(&mut self, call: &ResolverCall) -> bool {
        let Some(fee) = self.fees.get(&call.schema_uid) else { return true };
        if fee.amount == 0 {
            return true;
        }
        let (token, amount) = (fee.token.clone(), fee.amount);
        if self.charged.contains_key(&call.attestation_uid) {
            log!("attestation {} was already charged", call.attestation_uid);
            return false;
        }
        let balance = self.balance(&call.attester, &token);
        if balance < amount {
            log!("{} has a prepaid balance of {balance}; the fee is {amount}", call.attester);
            return false;
        }
        self.set_balance(&call.attester, &token, balance - amount);
        self.charged.insert(
            call.attestation_uid,
            Charge {
                payer: call.attester.clone(),
                schema_uid: call.schema_uid,
                token: token.clone(),
                amount,
            },
        );
        emit(
            FEE_CHARGED,
            &json!({
                "schema_uid": call.schema_uid,
                "attestation_uid": call.attestation_uid,
                "payer": call.attester,
                "token": token,
                "amount": U128(amount),
            }),
        );
        true
    }

    pub(crate) fn refund_fee(&mut self, call: &ResolverCall) {
        let Some(charge) = self.charged.remove(&call.attestation_uid) else { return };
        let balance = self.balance(&charge.payer, &charge.token).saturating_add(charge.amount);
        self.set_balance(&charge.payer, &charge.token, balance);
        emit(
            FEE_REFUNDED,
            &json!({
                "schema_uid": charge.schema_uid,
                "attestation_uid": call.attestation_uid,
                "payer": charge.payer,
                "token": charge.token,
                "amount": U128(charge.amount),
            }),
        );
    }

    pub(crate) fn commit_fee(&mut self, call: &ResolverCall) {
        let Some(charge) = self.charged.remove(&call.attestation_uid) else { return };
        let key = (charge.schema_uid, charge.token);
        let total = self.collected.get(&key).copied().unwrap_or(0).saturating_add(charge.amount);
        self.collected.insert(key, total);
    }

    fn balance(&self, account_id: &AccountId, token: &Option<AccountId>) -> u128 {
        self.balances.get(&(account_id.clone(), token.clone())).copied().unwrap_or(0)
    }

    fn set_balance(&mut self, account_id: &AccountId, token: &Option<AccountId>, value: u128) {
        let key = (account_id.clone(), token.clone());
        if value == 0 {
            self.balances.remove(&key);
        } else {
            self.balances.insert(key, value);
        }
    }

    /// Adds `amount` to a prepaid balance, logs `fee_deposited` and returns the new balance.
    fn credit_balance(&mut self, account_id: &AccountId, token: &Option<AccountId>, amount: u128) -> u128 {
        let balance = self
            .balance(account_id, token)
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("balance overflow"));
        self.set_balance(account_id, token, balance);
        emit(
            FEE_DEPOSITED,
            &json!({ "account_id": account_id, "token": token, "amount": U128(amount), "balance": U128(balance) }),
        );
        balance
    }
}

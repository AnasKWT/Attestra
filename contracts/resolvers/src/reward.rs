//! Token reward: each schema pays a fixed amount of one NEP-141 token to the subject of every
//! stored attestation, out of a pool anyone can fund with `ft_transfer_call` and the message
//! `{"fund":"<schema uid>"}`. The payout registers the subject on the token first (0.00125 NEAR
//! from this account; a registered subject gets it refunded by the token).
//!
//! Anyone may attest under a public schema, so a schema that pays rewards usually puts a
//! whitelist in front of this resolver through a pipeline.

use crate::*;
use attestra_common::events::{REWARD_FUNDED, REWARD_PAID, REWARD_POOL_WITHDRAWN};
use attestra_common::{near_subject, promise_succeeded};
use near_contract_standards::storage_management::ext_storage_management;
use near_sdk::serde::Deserialize;
use near_sdk::{log, serde_json};

/// NEAR attached to `storage_deposit` before a payout: the NEP-145 minimum of a standard token.
const REWARD_STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);

#[near(serializers = [borsh])]
pub(crate) struct Reward {
    pub token: AccountId,
    pub amount: u128,
    pub pool: u128,
    /// Taken from the pool for transfers that have not settled yet.
    pub pending: u128,
    pub distributed_total: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RewardView {
    pub token: AccountId,
    pub amount: U128,
    pub pool: U128,
    pub distributed_total: U128,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct FundMsg {
    fund: Uid,
}

#[near]
impl Contract {
    /// Sets the reward token and the amount paid per attestation. The token can only change
    /// while the pool is empty and nothing has been paid, so every tally stays in one token.
    #[payable]
    pub fn set_reward(&mut self, schema_uid: Uid, token: AccountId, amount: U128) {
        self.require_kind(ResolverKind::TokenReward);
        self.assert_admin(&schema_uid);
        let before = env::storage_usage();
        match self.rewards.get_mut(&schema_uid) {
            Some(reward) => {
                if reward.token != token {
                    require!(
                        reward.pool == 0 && reward.pending == 0 && reward.distributed_total == 0,
                        "the reward token cannot change after the pool was funded or paid out"
                    );
                    reward.token = token.clone();
                }
                reward.amount = amount.0;
            }
            None => {
                let reward = Reward {
                    token: token.clone(),
                    amount: amount.0,
                    pool: 0,
                    pending: 0,
                    distributed_total: 0,
                };
                self.rewards.insert(schema_uid, reward);
            }
        }
        self.rewards.flush();
        settle_deposit(before);
        self.configured(Some(&schema_uid), "reward", json!({ "token": token, "amount": amount }));
    }

    pub fn get_reward(&self, schema_uid: Uid) -> Option<RewardView> {
        self.require_kind(ResolverKind::TokenReward);
        self.rewards.get(&schema_uid).map(|r| RewardView {
            token: r.token.clone(),
            amount: U128(r.amount),
            pool: U128(r.pool),
            distributed_total: U128(r.distributed_total),
        })
    }

    /// Rewards paid to `account_id` under `schema_uid`.
    pub fn distributed(&self, schema_uid: Uid, account_id: AccountId) -> U128 {
        self.require_kind(ResolverKind::TokenReward);
        U128(self.distributed.get(&(schema_uid, account_id)).copied().unwrap_or(0))
    }

    /// Sends tokens from the pool back to the schema admin (all of it when `amount` is None).
    /// Resolves to the amount sent; a failed transfer puts it back in the pool and resolves to 0.
    pub fn withdraw_reward_pool(&mut self, schema_uid: Uid, amount: Option<U128>) -> Promise {
        self.require_kind(ResolverKind::TokenReward);
        let admin = self.assert_admin(&schema_uid);
        let reward = self
            .rewards
            .get_mut(&schema_uid)
            .unwrap_or_else(|| env::panic_str("no reward is configured for this schema"));
        let amount = amount.map_or(reward.pool, |a| a.0);
        require!(amount > 0, "nothing to withdraw");
        require!(amount <= reward.pool, "amount exceeds the reward pool");
        reward.pool -= amount;
        reward.pending += amount;
        let token = Some(reward.token.clone());
        send(&admin, &token, amount).then(this(GAS_CALLBACK).pool_withdrawn(
            schema_uid,
            admin.clone(),
            U128(amount),
        ))
    }

    #[private]
    pub fn pool_withdrawn(&mut self, schema_uid: Uid, admin: AccountId, amount: U128) -> U128 {
        let sent = promise_succeeded();
        let Some(reward) = self.rewards.get_mut(&schema_uid) else { return U128(0) };
        reward.pending = reward.pending.saturating_sub(amount.0);
        if sent {
            emit(
                REWARD_POOL_WITHDRAWN,
                &json!({ "schema_uid": schema_uid, "token": reward.token, "admin": admin, "amount": amount, "pool": U128(reward.pool) }),
            );
            amount
        } else {
            reward.pool = reward.pool.saturating_add(amount.0);
            log!("sending {} from the reward pool to {admin} failed; it was put back", amount.0);
            U128(0)
        }
    }

    /// Settles a payout: a successful `ft_transfer` is added to the tallies, a failed one goes
    /// back to the pool.
    #[private]
    pub fn reward_settled(&mut self, schema_uid: Uid, subject: AccountId, amount: U128) -> bool {
        let paid = promise_succeeded();
        let Some(reward) = self.rewards.get_mut(&schema_uid) else { return false };
        reward.pending = reward.pending.saturating_sub(amount.0);
        if !paid {
            reward.pool = reward.pool.saturating_add(amount.0);
            log!("reward of {} to {subject} failed; it was put back in the pool", amount.0);
            return false;
        }
        reward.distributed_total = reward.distributed_total.saturating_add(amount.0);
        let token = reward.token.clone();
        let key = (schema_uid, subject.clone());
        let total = self.distributed.get(&key).copied().unwrap_or(0).saturating_add(amount.0);
        self.distributed.insert(key, total);
        emit(
            REWARD_PAID,
            &json!({ "schema_uid": schema_uid, "account_id": subject, "token": token, "amount": amount }),
        );
        true
    }
}

impl Contract {
    pub(crate) fn reward_on_transfer(
        &mut self,
        token: AccountId,
        sender_id: AccountId,
        amount: u128,
        msg: &str,
    ) -> U128 {
        let Ok(FundMsg { fund: schema_uid }) = serde_json::from_str::<FundMsg>(msg) else {
            log!("expected {{\"fund\":\"<schema uid>\"}}; returning the tokens");
            return U128(amount);
        };
        let Some(reward) = self.rewards.get_mut(&schema_uid) else {
            log!("no reward is configured for schema {schema_uid}; returning the tokens");
            return U128(amount);
        };
        if reward.token != token {
            log!("schema {schema_uid} pays rewards in {}; returning the tokens", reward.token);
            return U128(amount);
        }
        reward.pool = reward.pool.checked_add(amount).unwrap_or_else(|| env::panic_str("pool overflow"));
        emit(
            REWARD_FUNDED,
            &json!({ "schema_uid": schema_uid, "token": token, "sender_id": sender_id, "amount": U128(amount), "pool": U128(reward.pool) }),
        );
        U128(0)
    }

    pub(crate) fn pay_reward(&mut self, call: &ResolverCall) {
        if !is_attest(call) {
            return;
        }
        let Some(subject) = near_subject(&call.subject) else {
            log!("subject {} is not a NEAR account; no reward", call.subject);
            return;
        };
        let Some(reward) = self.rewards.get_mut(&call.schema_uid) else { return };
        let amount = reward.amount;
        if amount == 0 {
            return;
        }
        if reward.pool < amount {
            log!(
                "the reward pool of schema {} holds {}; the reward is {amount}",
                call.schema_uid,
                reward.pool
            );
            return;
        }
        reward.pool -= amount;
        reward.pending += amount;
        let token = reward.token.clone();
        let memo = format!("Attestra reward for attestation {}", call.attestation_uid);
        ext_storage_management::ext(token.clone())
            .with_attached_deposit(REWARD_STORAGE_DEPOSIT)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .with_unused_gas_weight(0)
            .storage_deposit(Some(subject.clone()), Some(true))
            .then(
                ext_ft_core::ext(token)
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FT_TRANSFER)
                    .with_unused_gas_weight(0)
                    .ft_transfer(subject.clone(), U128(amount), Some(memo)),
            )
            .then(this(GAS_CALLBACK).reward_settled(call.schema_uid, subject, U128(amount)))
            .detach();
    }
}

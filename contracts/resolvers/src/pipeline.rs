//! Pipeline: up to four resolvers called in order for one schema. Each step waits for the
//! previous one; the first refusal (or failure) stops the run and, for an attestation, calls
//! `on_aborted` on every resolver that already approved. `on_aborted` and `on_committed` are
//! forwarded to the resolvers of the run that approved the attestation.
//!
//! Every resolver in a pipeline must list the pipeline in its `trusted_pipelines`.
//!
//! Gas: an attestation through a pipeline of n resolvers needs about 35 + 40n Tgas (25 Tgas per
//! hook call plus 15 Tgas per step), and the leftover is shared between the hooks and steps.

use crate::*;
use attestra_common::promise_bool;
use attestra_common::resolver::ext_resolver;
use near_sdk::{log, serde_json};

const MAX_RESOLVERS: usize = 4;
/// Static gas for one hook call (`on_attest` or `on_revoke`) from a pipeline step.
const GAS_HOOK: Gas = Gas::from_tgas(25);
/// Static gas per remaining resolver reserved for a step: its own work, the next hook call and
/// the steps after it, or the aborts of a refused run.
const GAS_STEP_TGAS: u64 = 40;
/// Static gas for a forwarded `on_schema_registered`, `on_aborted` or `on_committed`.
const GAS_FORWARD: Gas = Gas::from_tgas(10);

#[near]
impl Contract {
    /// Sets the resolvers for `schema_uid`: 1 to 4 distinct accounts, not this one. Each must
    /// accept the schema through `on_schema_registered` with this schema's admin; the list is
    /// stored only when all of them do. Resolves to true when stored.
    #[payable]
    pub fn set_pipeline(&mut self, schema_uid: Uid, resolvers: Vec<AccountId>) -> Promise {
        self.require_kind(ResolverKind::Pipeline);
        let admin = self.assert_admin(&schema_uid);
        require!(
            !resolvers.is_empty() && resolvers.len() <= MAX_RESOLVERS,
            format!("a pipeline has 1 to {MAX_RESOLVERS} resolvers")
        );
        let me = env::current_account_id();
        for (i, resolver) in resolvers.iter().enumerate() {
            require!(*resolver != me, "a pipeline cannot include itself");
            require!(!resolvers[..i].contains(resolver), "pipeline resolvers must be distinct");
        }
        let registrations = resolvers
            .iter()
            .map(|r| {
                ext_resolver::ext(r.clone())
                    .with_static_gas(GAS_FORWARD)
                    .with_unused_gas_weight(0)
                    .on_schema_registered(schema_uid, admin.clone())
            })
            .reduce(Promise::and)
            .unwrap_or_else(|| env::panic_str("a pipeline has at least one resolver"));
        registrations.then(this(GAS_CALLBACK).pipeline_configured(
            schema_uid,
            resolvers,
            env::predecessor_account_id(),
            U128(env::attached_deposit().as_yoctonear()),
        ))
    }

    /// Stores the pipeline when every resolver returned true, paying its storage from `deposit`
    /// and refunding the rest to `payer`. Otherwise stores nothing and refunds everything.
    #[private]
    pub fn pipeline_configured(
        &mut self,
        schema_uid: Uid,
        resolvers: Vec<AccountId>,
        payer: AccountId,
        deposit: U128,
    ) -> bool {
        let results = env::promise_results_count();
        let refused: Vec<&str> = resolvers
            .iter()
            .enumerate()
            .filter(|(i, _)| {
                let i = *i as u64;
                i >= results
                    || !env::promise_result_checked(i, 16)
                        .is_ok_and(|bytes| serde_json::from_slice::<bool>(&bytes).unwrap_or(false))
            })
            .map(|(_, r)| r.as_str())
            .collect();
        if !refused.is_empty() || results != resolvers.len() as u64 {
            log!("pipeline for schema {schema_uid} not stored: refused by {}", refused.join(", "));
            refund(&payer, deposit.0);
            return false;
        }
        let before = env::storage_usage();
        let previous = self.pipelines.insert(schema_uid, resolvers.clone());
        self.pipelines.flush();
        let cost = storage_cost(before);
        if cost > deposit.0 {
            match previous {
                Some(previous) => self.pipelines.insert(schema_uid, previous),
                None => self.pipelines.remove(&schema_uid),
            };
            self.pipelines.flush();
            log!("pipeline for schema {schema_uid} not stored: attach at least {cost} yoctoNEAR for storage");
            refund(&payer, deposit.0);
            return false;
        }
        refund(&payer, deposit.0 - cost);
        self.configured(Some(&schema_uid), "pipeline", json!(resolvers));
        true
    }

    pub fn get_pipeline(&self, schema_uid: Uid) -> Vec<AccountId> {
        self.require_kind(ResolverKind::Pipeline);
        self.pipelines.get(&schema_uid).cloned().unwrap_or_default()
    }

    /// Handles the result of `resolvers[index]`: continues with the next resolver, or finishes
    /// the run. A refused attestation is aborted on every resolver before `index`.
    #[private]
    pub fn pipeline_step(
        &mut self,
        call: ResolverCall,
        resolvers: Vec<AccountId>,
        index: u32,
    ) -> PromiseOrValue<bool> {
        let index = index as usize;
        if promise_bool() {
            if index + 1 < resolvers.len() {
                return PromiseOrValue::Promise(step(call, resolvers, index + 1));
            }
            if is_attest(&call) {
                self.runs.insert(call.attestation_uid, resolvers);
            }
            return PromiseOrValue::Value(true);
        }
        if let Some(resolver) = resolvers.get(index) {
            log!("{resolver} refused attestation {}", call.attestation_uid);
        }
        if is_attest(&call) {
            for resolver in resolvers.iter().take(index) {
                ext_resolver::ext(resolver.clone())
                    .with_static_gas(GAS_FORWARD)
                    .with_unused_gas_weight(0)
                    .on_aborted(call.clone())
                    .detach();
            }
        }
        PromiseOrValue::Value(false)
    }
}

impl Contract {
    pub(crate) fn run_pipeline(&self, call: ResolverCall) -> PromiseOrValue<bool> {
        match self.pipelines.get(&call.schema_uid) {
            None => PromiseOrValue::Value(true),
            Some(resolvers) => PromiseOrValue::Promise(step(call, resolvers.clone(), 0)),
        }
    }

    /// Forwards `on_aborted` or `on_committed` to the resolvers that approved the attestation (or
    /// the configured pipeline when no run is recorded, as for a revocation).
    pub(crate) fn forward_pipeline(&mut self, call: &ResolverCall, committed: bool) {
        let recorded = if is_attest(call) { self.runs.remove(&call.attestation_uid) } else { None };
        let Some(resolvers) = recorded.or_else(|| self.pipelines.get(&call.schema_uid).cloned()) else {
            return;
        };
        for resolver in resolvers {
            let hook = ext_resolver::ext(resolver).with_static_gas(GAS_FORWARD);
            let promise =
                if committed { hook.on_committed(call.clone()) } else { hook.on_aborted(call.clone()) };
            promise.detach();
        }
    }
}

/// Calls the hook of `resolvers[index]` and chains `pipeline_step` on its result.
fn step(call: ResolverCall, resolvers: Vec<AccountId>, index: usize) -> Promise {
    let hook = ext_resolver::ext(resolvers[index].clone()).with_static_gas(GAS_HOOK);
    let hook = if is_attest(&call) { hook.on_attest(call.clone()) } else { hook.on_revoke(call.clone()) };
    let remaining = (resolvers.len() - index) as u64;
    let next = Contract::ext(env::current_account_id())
        .with_static_gas(Gas::from_tgas(GAS_STEP_TGAS * remaining))
        .pipeline_step(call, resolvers, index as u32);
    hook.then(next)
}

//! The resolver gate: an operation stays pending while the schema's resolver decides, then the
//! callback commits it or rolls it back.

use crate::*;
use attestra_common::events::emit;
use attestra_common::promise_bool;
use attestra_common::resolver::{ext_resolver, ResolverCall, ResolverOp};
use near_sdk::{Gas, Promise};

/// Gas the resolver call gets at least; it also receives all unused gas.
const GAS_RESOLVER: Gas = Gas::from_tgas(20);
/// The callback's own work plus the post-commit hook and a credential burn it may start.
const GAS_VERDICT: Gas = Gas::from_tgas(95);
const GAS_COMMITTED_HOOK: Gas = Gas::from_tgas(60);

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct PendingOp {
    pub resolver: AccountId,
    pub call: ResolverCall,
    pub revoke_at: u64,
}

impl Contract {
    pub(crate) fn gate(&mut self, resolver: AccountId, call: ResolverCall, revoke_at: u64) -> Promise {
        let id = self.op_count;
        self.op_count += 1;
        self.pending.insert(id, PendingOp { resolver: resolver.clone(), call: call.clone(), revoke_at });
        let ask = match call.op {
            ResolverOp::Attest => ext_resolver::ext(resolver)
                .with_static_gas(GAS_RESOLVER)
                .with_unused_gas_weight(1)
                .on_attest(call),
            ResolverOp::Revoke | ResolverOp::Schedule => ext_resolver::ext(resolver)
                .with_static_gas(GAS_RESOLVER)
                .with_unused_gas_weight(1)
                .on_revoke(call),
        };
        ask.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_VERDICT)
                .with_unused_gas_weight(0)
                .on_resolver_verdict(id),
        )
    }
}

#[near]
impl Contract {
    /// Commits or rolls back a pending operation. Never panics: a rollback must persist.
    #[private]
    pub fn on_resolver_verdict(&mut self, op_id: u64) -> Outcome {
        let approved = promise_bool();
        let op = self.pending.remove(&op_id).unwrap_or_else(|| env::panic_str("unknown operation"));
        let uid = op.call.attestation_uid;
        match op.call.op {
            ResolverOp::Attest => {
                if approved {
                    let a = self.attestations.get_mut(&uid).expect("pending attestation");
                    a.state = State::Active;
                    let (expiration_time, nonce, ref_uid) = (a.expiration_time, a.nonce, a.ref_uid);
                    self.attestation_count += 1;
                    emit(
                        events::ATTESTATION_CREATED,
                        &json!({
                            "uid": uid, "schema_uid": op.call.schema_uid, "attester": op.call.attester,
                            "subject": op.call.subject, "actor": op.call.actor, "nonce": nonce,
                            "expiration_time": expiration_time, "ref_uid": ref_uid,
                        }),
                    );
                    ext_resolver::ext(op.resolver)
                        .with_static_gas(GAS_COMMITTED_HOOK)
                        .on_committed(op.call)
                        .detach();
                    Outcome::new(uid, "created")
                } else {
                    let payer = self.attestations.get(&uid).map(|a| a.payer.clone());
                    let before = env::storage_usage();
                    self.attestations.remove(&uid);
                    self.attestations.flush();
                    if let Some(payer) = payer {
                        self.ledger.settle(&payer, before, env::storage_usage());
                    }
                    emit(
                        events::ATTESTATION_REJECTED,
                        &json!({ "uid": uid, "schema_uid": op.call.schema_uid, "attester": op.call.attester, "resolver": op.resolver }),
                    );
                    Outcome::new(uid, "rejected")
                }
            }
            ResolverOp::Revoke | ResolverOp::Schedule => {
                if approved {
                    if op.call.op == ResolverOp::Schedule {
                        self.apply_schedule(uid, op.revoke_at, &op.call.actor)
                    } else {
                        self.apply_revoke(uid, &op.call.actor)
                    }
                } else {
                    if let Some(a) = self.attestations.get_mut(&uid) {
                        a.state = State::Active;
                    }
                    emit(
                        events::REVOCATION_REJECTED,
                        &json!({ "uid": uid, "attester": op.call.attester, "resolver": op.resolver }),
                    );
                    Outcome::new(uid, "refused")
                }
            }
        }
    }

    /// Operations waiting for a resolver.
    pub fn pending_operation_count(&self) -> u64 {
        self.op_count
    }
}

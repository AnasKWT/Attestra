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
/// The most the resolver call can use: a pipeline of four resolvers needs 35 + 40 * 4 Tgas.
/// Gas attached beyond this (and the verdict) goes to the verdict, so a pipeline forwarding
/// `on_committed` to several resolvers (a reward payout among them) gets enough when the caller
/// attaches more.
const GAS_RESOLVER_CAP: Gas = Gas::from_tgas(200);
/// What `gate` and the rest of its call may still burn after measuring the gas left.
const GAS_GATE_RESERVE: Gas = Gas::from_tgas(30);

/// What the callback needs besides the attestation record, which holds the rest of the call
/// (schema, attester, subject and data). Keeping the payload out of this entry means the
/// contract, which pays for pending entries, never stores a second copy of it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct PendingOp {
    pub resolver: AccountId,
    pub op: ResolverOp,
    pub attestation_uid: Uid,
    pub actor: AccountId,
    pub revoke_at: u64,
}

impl Contract {
    pub(crate) fn gate(&mut self, resolver: AccountId, call: ResolverCall, revoke_at: u64) -> Promise {
        let id = self.op_count;
        self.op_count += 1;
        adjust_pending(1);
        self.pending.insert(
            id,
            PendingOp {
                resolver: resolver.clone(),
                op: call.op,
                attestation_uid: call.attestation_uid,
                actor: call.actor.clone(),
                revoke_at,
            },
        );
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
        let left = env::prepaid_gas().saturating_sub(env::used_gas());
        let extra = left
            .saturating_sub(GAS_RESOLVER_CAP.saturating_add(GAS_VERDICT).saturating_add(GAS_GATE_RESERVE));
        ask.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_VERDICT.saturating_add(extra))
                .with_unused_gas_weight(0)
                .on_resolver_verdict(id),
        )
    }
}

/// A pending operation with its resolver call read back from the attestation record.
struct PendingCall {
    resolver: AccountId,
    call: ResolverCall,
    revoke_at: u64,
}

impl Contract {
    /// The resolver call of a pending operation. The attestation exists until the callback
    /// that removes a rejected one, so the record is always there.
    fn resolver_call(&self, op: &PendingOp) -> ResolverCall {
        let a = self.attestations.get(&op.attestation_uid).expect("pending attestation");
        ResolverCall {
            op: op.op,
            attestation_uid: op.attestation_uid,
            schema_uid: a.schema_uid,
            attester: a.attester.clone(),
            actor: op.actor.clone(),
            subject: a.subject.clone(),
            data: Base64VecU8(a.data.clone()),
        }
    }
}

#[near]
impl Contract {
    /// Commits or rolls back a pending operation. Neither outcome panics, so a rollback always
    /// persists; it panics only on a broken invariant (an operation id it never issued).
    #[private]
    pub fn on_resolver_verdict(&mut self, op_id: u64) -> Outcome {
        let approved = promise_bool();
        let pending = self.pending.remove(&op_id).unwrap_or_else(|| env::panic_str("unknown operation"));
        adjust_pending(-1);
        let uid = pending.attestation_uid;
        let call = self.resolver_call(&pending);
        let op = PendingCall { resolver: pending.resolver, call, revoke_at: pending.revoke_at };
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

    /// Operations waiting for a resolver's answer right now.
    pub fn pending_operation_count(&self) -> u64 {
        env::storage_read(PENDING_COUNT_KEY).and_then(|b| b.try_into().ok()).map(u64::from_le_bytes).unwrap_or(0)
    }

    /// Operations ever sent to a resolver.
    pub fn gated_operation_count(&self) -> u64 {
        self.op_count
    }
}

/// The pending count, kept in its own storage key so adding it needed no state migration.
const PENDING_COUNT_KEY: &[u8] = b"pending_count";

fn adjust_pending(delta: i64) {
    let now = env::storage_read(PENDING_COUNT_KEY).and_then(|b| b.try_into().ok()).map(u64::from_le_bytes).unwrap_or(0);
    let next = if delta >= 0 { now.saturating_add(delta as u64) } else { now.saturating_sub(delta.unsigned_abs()) };
    env::storage_write(PENDING_COUNT_KEY, &next.to_le_bytes());
}

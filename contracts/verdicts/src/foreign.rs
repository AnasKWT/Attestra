//! Facts about other chains: an EVM log verified and signed by the NEAR MPC network.

use crate::mpc::{
    self, EvmLog, HexArray, VerifyForeignTransactionRequestArgs, VerifyForeignTransactionResponse,
};
use crate::*;
use attestra_common::events::{self, emit};
use attestra_common::is_valid_subject;
use near_sdk::serde_json::{self, json};
use near_sdk::{borsh, NearToken, Promise};

/// Gas for `verify_foreign_transaction` (the MPC requires 15 TGas and keeps 7 for its yield).
pub(crate) const GAS_MPC: Gas = Gas::from_tgas(25);
/// The callback's own work (ecrecover, storage, events).
pub(crate) const GAS_VERIFY_WORK: Gas = Gas::from_tgas(15);
/// The follow-up that releases the event when `attest` failed.
pub(crate) const GAS_AFTER_ATTEST: Gas = Gas::from_tgas(10);
/// Largest MPC response read in the callback.
pub(crate) const MAX_RESPONSE_LEN: usize = 4 * 1024;
const MAX_TOPICS: usize = 4;
const MAX_LOG_DATA_BYTES: usize = 8 * 1024;
/// A `used_payloads` entry: prefix, 32-byte hash, empty value and the record overhead.
pub(crate) const PAYLOAD_ENTRY_BYTES: u64 = 1 + 32 + RECORD_OVERHEAD_BYTES;

/// A log the caller expects the MPC network to find in a finalized EVM transaction.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForeignEventClaim {
    /// `ethereum`, `base`, `arbitrum`, `polygon`, `bnb` or `avalanche`.
    pub chain: String,
    /// The transaction hash, 32 bytes hex (optional `0x`).
    pub tx_id: String,
    /// The block-level log index (`logIndex` in the receipt).
    pub log_index: u64,
    /// The log exactly as the chain's RPC returns it in the receipt.
    pub log: EvmLog,
    /// Defaults to the emitting contract, `eip155:<chain id>:0x<address>`.
    pub subject: Option<String>,
}

/// A checked claim: the MPC request and the hash it must sign.
struct Prepared {
    tx_id: mpc::Hash256,
    request: mpc::ForeignChainRpcRequest,
    payload_hash: mpc::Hash256,
    subject: String,
    data: Vec<u8>,
}

impl Prepared {
    /// What attesting this event costs in storage: the payload entry here and the attestation
    /// there.
    fn deposit(&self) -> u128 {
        storage_cost(PAYLOAD_ENTRY_BYTES) + attestation_deposit(&self.subject, self.data.len())
    }
}

#[near]
impl Contract {
    /// The deposit `attest_foreign_event` needs for `claim`, in yoctoNEAR.
    pub fn foreign_event_deposit(&self, claim: ForeignEventClaim) -> U128 {
        U128(self.prepare(&claim).unwrap_or_else(|e| env::panic_str(&e)).deposit())
    }

    /// Asks the MPC network to verify a log of an EVM transaction; the callback attests it under
    /// the `foreign_tx` schema. Attach 300 TGas and at least `foreign_event_deposit` (the rest is
    /// refunded): it pays for the event's storage and is refunded when the event is not attested.
    /// The 1 yoctoNEAR the MPC requires comes from this contract's balance.
    #[payable]
    pub fn attest_foreign_event(&mut self, claim: ForeignEventClaim) -> Promise {
        self.schemas();
        require!(self.mpc_key.is_some(), "the MPC key is not configured");
        require_gas();
        let p = self.prepare(&claim).unwrap_or_else(|e| env::panic_str(&e));
        let uid = Uid(p.payload_hash.0);
        require!(!self.used_payloads.contains(&uid), "this event was already attested");
        let deposit = p.deposit();
        take_deposit(deposit, "the event and its attestation");

        emit(
            events::FOREIGN_TX_REQUESTED,
            &json!({
                "payload_hash": uid, "chain": claim.chain, "tx_id": p.tx_id.to_hex(), "log_index": claim.log_index,
                "subject": p.subject, "requester": env::predecessor_account_id(),
            }),
        );
        let args = VerifyForeignTransactionRequestArgs {
            request: p.request,
            domain_id: self.mpc_domain_id,
            payload_version: mpc::PAYLOAD_VERSION_V1,
            expected_payload_hash: Some(p.payload_hash),
        };
        Promise::new(self.mpc.clone())
            .function_call_weight(
                "verify_foreign_transaction".to_string(),
                serde_json::to_vec(&json!({ "request": args })).expect("json"),
                NearToken::from_yoctonear(mpc::MPC_DEPOSIT_YOCTO),
                GAS_MPC,
                near_sdk::GasWeight(0),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(
                        GAS_VERIFY_WORK.saturating_add(GAS_ATTEST).saturating_add(GAS_AFTER_ATTEST),
                    )
                    .with_unused_gas_weight(1)
                    .on_foreign_verified(claim, env::predecessor_account_id(), U128(deposit)),
            )
    }

    /// Checks the MPC's answer and attests the event, forwarding the attestation's share of
    /// `deposit`. Never panics: a failed or wrong answer emits `foreign_tx_failed`, refunds
    /// `deposit` to `requester` and returns `failed`.
    #[private]
    pub fn on_foreign_verified(
        &mut self,
        claim: ForeignEventClaim,
        requester: AccountId,
        deposit: U128,
    ) -> PromiseOrValue<Outcome> {
        let outcome = self.verify_and_attest(&claim, &requester, deposit.0);
        if let PromiseOrValue::Value(_) = &outcome {
            refund(&requester, deposit.0);
        }
        outcome
    }

    /// Passes the attestation's outcome through. When `attest` failed or the schema's resolver
    /// rejected it, the event is released so it can be attested again, and `requester` gets back
    /// what is still here: all of `deposit` when the call failed (its attached deposit came back),
    /// the payload entry's share when the resolver rejected it (the rest stays in this contract's
    /// storage balance at the attestations contract).
    #[private]
    pub fn on_foreign_attested(
        &mut self,
        claim: ForeignEventClaim,
        payload_hash: Uid,
        requester: AccountId,
        deposit: U128,
    ) -> Outcome {
        let outcome = (env::promise_results_count() == 1)
            .then(|| env::promise_result_checked(0, MAX_RESPONSE_LEN).ok())
            .flatten()
            .and_then(|bytes| serde_json::from_slice::<Outcome>(&bytes).ok());
        match outcome {
            Some(o) if o.status != "rejected" => o,
            Some(o) => {
                self.used_payloads.remove(&payload_hash);
                refund(&requester, storage_cost(PAYLOAD_ENTRY_BYTES).min(deposit.0));
                self.foreign_failed(&claim, payload_hash, "the schema resolver rejected the attestation");
                o
            }
            None => {
                self.used_payloads.remove(&payload_hash);
                refund(&requester, deposit.0);
                self.foreign_failed(&claim, payload_hash, "the attestation call failed")
            }
        }
    }
}

impl Contract {
    /// `on_foreign_verified` without the refund: a value is a failure, a promise is the attest.
    fn verify_and_attest(
        &mut self,
        claim: &ForeignEventClaim,
        requester: &AccountId,
        deposit: u128,
    ) -> PromiseOrValue<Outcome> {
        let p = match self.prepare(claim) {
            Ok(p) => p,
            Err(e) => return PromiseOrValue::Value(self.foreign_failed(claim, Uid([0; 32]), &e)),
        };
        let uid = Uid(p.payload_hash.0);
        let response = match read_response() {
            Ok(r) => r,
            Err(e) => return PromiseOrValue::Value(self.foreign_failed(claim, uid, &e)),
        };
        if response.payload_hash != p.payload_hash {
            return PromiseOrValue::Value(self.foreign_failed(
                claim,
                uid,
                "the MPC signed another payload hash",
            ));
        }
        if !self.mpc_signed(&response, &p.payload_hash) {
            return PromiseOrValue::Value(self.foreign_failed(claim, uid, "invalid MPC signature"));
        }
        let Some(schema_uid) = self.schemas.as_ref().map(|s| s.foreign_tx) else {
            return PromiseOrValue::Value(self.foreign_failed(claim, uid, "schemas are not configured"));
        };
        let forwarded = attestation_deposit(&p.subject, p.data.len());
        if forwarded > deposit {
            return PromiseOrValue::Value(self.foreign_failed(
                claim,
                uid,
                "the deposit does not cover the storage",
            ));
        }
        if !self.used_payloads.insert(uid) {
            return PromiseOrValue::Value(self.foreign_failed(claim, uid, "this event was already attested"));
        }
        emit(
            events::FOREIGN_TX_VERIFIED,
            &json!({
                "payload_hash": uid, "chain": claim.chain, "tx_id": p.tx_id.to_hex(), "log_index": claim.log_index,
                "block_number": claim.log.block_number, "emitter": format!("0x{}", claim.log.address.to_hex()),
                "subject": p.subject,
            }),
        );
        PromiseOrValue::Promise(
            self.attest(schema_uid, p.subject, p.data, None, forwarded).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_AFTER_ATTEST)
                    .with_unused_gas_weight(0)
                    .on_foreign_attested(claim.clone(), uid, requester.clone(), U128(deposit)),
            ),
        )
    }

    fn prepare(&self, claim: &ForeignEventClaim) -> Result<Prepared, String> {
        let chain_id = mpc::chain_id(&claim.chain, self.is_testnet())
            .ok_or_else(|| format!("unknown chain {}", claim.chain))?;
        let tx_id =
            HexArray::<32>::from_hex(&claim.tx_id).ok_or("tx_id must be 32 bytes of hex".to_string())?;
        let log = &claim.log;
        if log.log_index != claim.log_index {
            return Err("log.log_index differs from log_index".into());
        }
        if log.transaction_hash != tx_id {
            return Err("log.transaction_hash differs from tx_id".into());
        }
        if log.removed {
            return Err("the log was removed".into());
        }
        if log.topics.len() > MAX_TOPICS {
            return Err("a log has at most 4 topics".into());
        }
        let data = log
            .data
            .strip_prefix("0x")
            .and_then(|d| hex::decode(d).ok())
            .ok_or("log.data must be 0x-prefixed hex".to_string())?;
        if data.len() > MAX_LOG_DATA_BYTES {
            return Err("log.data is larger than 8 KiB".into());
        }
        let subject =
            claim.subject.clone().unwrap_or_else(|| format!("eip155:{chain_id}:0x{}", log.address.to_hex()));
        if !is_valid_subject(&subject) {
            return Err("subject must be a NEAR account id or a CAIP-10 account id".into());
        }
        let (request, payload_hash) =
            mpc::log_request(&claim.chain, tx_id, log).ok_or(format!("unknown chain {}", claim.chain))?;
        let topics: Vec<[u8; 32]> = log.topics.iter().map(|t| t.0).collect();
        let data = borsh::to_vec(&(
            &claim.chain,
            &tx_id.0,
            log.block_number,
            log.address.0.to_vec(),
            topics,
            data,
            claim.log_index,
        ))
        .expect("borsh");
        Ok(Prepared { tx_id, request, payload_hash, subject, data })
    }

    /// True when `response` is the MPC key's secp256k1 signature over `payload_hash`.
    pub(crate) fn mpc_signed(
        &self,
        response: &VerifyForeignTransactionResponse,
        payload_hash: &mpc::Hash256,
    ) -> bool {
        let key = self.mpc_key.as_deref().and_then(mpc::parse_secp256k1_key);
        match (&response.signature, key) {
            (mpc::SignatureResponse::Secp256k1(sig), Some(key)) => {
                mpc::verify_secp256k1(sig, &payload_hash.0, &key)
            }
            _ => false,
        }
    }

    fn foreign_failed(&self, claim: &ForeignEventClaim, payload_hash: Uid, reason: &str) -> Outcome {
        emit(
            events::FOREIGN_TX_FAILED,
            &json!({
                "payload_hash": payload_hash, "chain": claim.chain, "tx_id": claim.tx_id,
                "log_index": claim.log_index, "reason": reason,
            }),
        );
        Outcome::new(payload_hash, "failed")
    }
}

/// The MPC's answer, or why there is none.
pub(crate) fn read_response() -> Result<VerifyForeignTransactionResponse, String> {
    if env::promise_results_count() != 1 {
        return Err("expected one promise result".into());
    }
    let bytes = env::promise_result_checked(0, MAX_RESPONSE_LEN)
        .map_err(|_| "the MPC call failed or timed out".to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "the MPC response is not a VerifyForeignTransactionResponse".into())
}

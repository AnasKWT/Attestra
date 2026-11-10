//! Facts about Solana: an inner instruction of a finalized transaction (for example the SPL token
//! transfer a program made), verified and signed by the NEAR MPC network.
//!
//! The flow matches the EVM one in `foreign.rs`: the contract computes the payload hash the MPC
//! must sign from the claim, asks `verify_foreign_transaction`, checks the secp256k1 signature
//! with `env::ecrecover` and attests under the `foreignInstruction` schema. The schema's uid is
//! kept under its own storage key, so adding Solana left the contract's stored state unchanged.

use crate::foreign::{
    read_response, GAS_AFTER_ATTEST, GAS_MPC, GAS_VERIFY_WORK, MAX_RESPONSE_LEN, PAYLOAD_ENTRY_BYTES,
};
use crate::mpc::{self, HexArray, SvmInnerInstruction, VerifyForeignTransactionRequestArgs};
use crate::*;
use attestra_common::events::{self, emit};
use attestra_common::is_valid_subject;
use near_sdk::serde_json::{self, json};
use near_sdk::{borsh, bs58, NearToken, Promise};

/// Where `set_instruction_schema` keeps the `foreignInstruction` schema uid.
const INSTRUCTION_SCHEMA_KEY: &[u8] = b"svm_schema";
/// Accounts and data bytes an inner instruction may carry (a transaction is at most 1232 bytes).
const MAX_ACCOUNTS: usize = 64;
const MAX_DATA_BYTES: usize = 1232;
/// CAIP-2 references of Solana mainnet and of devnet, which the testnet MPC network reads.
const SOLANA_MAINNET_REF: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET_REF: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/// An inner instruction the caller expects the MPC network to find in a finalized Solana
/// transaction, in the base58 form `getTransaction` returns.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForeignInstructionClaim {
    /// The transaction signature, base58.
    pub tx_id: String,
    /// The top-level instruction (`innerInstructions[].index`) and the position among its inner
    /// instructions.
    pub instruction_index: u64,
    pub inner_instruction_index: u64,
    /// The program, the accounts it was called with and the instruction data, all base58.
    pub program_id: String,
    pub accounts: Vec<String>,
    pub data: String,
    /// Defaults to the program, `solana:<chain reference>:<program id>`.
    pub subject: Option<String>,
}

pub(crate) struct Prepared {
    request: mpc::ForeignChainRpcRequest,
    pub(crate) payload_hash: mpc::Hash256,
    subject: String,
    data: Vec<u8>,
}

impl Prepared {
    fn deposit(&self) -> u128 {
        storage_cost(PAYLOAD_ENTRY_BYTES) + attestation_deposit(&self.subject, self.data.len())
    }
}

#[near]
impl Contract {
    /// Sets the `foreignInstruction` schema the Solana facts are attested under.
    #[payable]
    pub fn set_instruction_schema(&mut self, uid: Uid) {
        self.assert_owner();
        env::storage_write(INSTRUCTION_SCHEMA_KEY, &uid.0);
    }

    pub fn instruction_schema(&self) -> Option<Uid> {
        env::storage_read(INSTRUCTION_SCHEMA_KEY).and_then(|b| b.try_into().ok()).map(Uid)
    }

    /// The deposit `attest_foreign_instruction` needs for `claim`, in yoctoNEAR.
    pub fn foreign_instruction_deposit(&self, claim: ForeignInstructionClaim) -> U128 {
        U128(self.prepare_instruction(&claim).unwrap_or_else(|e| env::panic_str(&e)).deposit())
    }

    /// Asks the MPC network to verify an inner instruction of a Solana transaction; the callback
    /// attests it under the `foreignInstruction` schema. Attach 300 TGas and at least
    /// `foreign_instruction_deposit`, which pays for the fact's storage and comes back when it is
    /// not attested.
    #[payable]
    pub fn attest_foreign_instruction(&mut self, claim: ForeignInstructionClaim) -> Promise {
        require!(self.instruction_schema().is_some(), "the foreignInstruction schema is not configured");
        require!(self.mpc_key.is_some(), "the MPC key is not configured");
        require_gas();
        let p = self.prepare_instruction(&claim).unwrap_or_else(|e| env::panic_str(&e));
        let uid = Uid(p.payload_hash.0);
        require!(!self.used_payloads.contains(&uid), "this instruction was already attested");
        let deposit = p.deposit();
        take_deposit(deposit, "the instruction and its attestation");

        emit(
            events::FOREIGN_TX_REQUESTED,
            &json!({
                "payload_hash": uid, "chain": "solana", "tx_id": claim.tx_id,
                "instruction_index": claim.instruction_index, "inner_instruction_index": claim.inner_instruction_index,
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
                    .on_instruction_verified(claim, env::predecessor_account_id(), U128(deposit)),
            )
    }

    /// Checks the MPC's answer and attests the instruction. Never panics: a failed or wrong
    /// answer emits `foreign_tx_failed`, refunds `deposit` to `requester` and returns `failed`.
    #[private]
    pub fn on_instruction_verified(
        &mut self,
        claim: ForeignInstructionClaim,
        requester: AccountId,
        deposit: U128,
    ) -> PromiseOrValue<Outcome> {
        let outcome = self.verify_and_attest_instruction(&claim, &requester, deposit.0);
        if let PromiseOrValue::Value(_) = &outcome {
            refund(&requester, deposit.0);
        }
        outcome
    }

    /// Passes the attestation's outcome through, releasing the instruction and refunding what is
    /// still here when `attest` failed or the schema's resolver rejected it.
    #[private]
    pub fn on_instruction_attested(
        &mut self,
        claim: ForeignInstructionClaim,
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
                self.instruction_failed(&claim, payload_hash, "the schema resolver rejected the attestation");
                o
            }
            None => {
                self.used_payloads.remove(&payload_hash);
                refund(&requester, deposit.0);
                self.instruction_failed(&claim, payload_hash, "the attestation call failed")
            }
        }
    }
}

impl Contract {
    fn verify_and_attest_instruction(
        &mut self,
        claim: &ForeignInstructionClaim,
        requester: &AccountId,
        deposit: u128,
    ) -> PromiseOrValue<Outcome> {
        let p = match self.prepare_instruction(claim) {
            Ok(p) => p,
            Err(e) => return PromiseOrValue::Value(self.instruction_failed(claim, Uid([0; 32]), &e)),
        };
        let uid = Uid(p.payload_hash.0);
        let fail =
            |this: &Self, reason: &str| PromiseOrValue::Value(this.instruction_failed(claim, uid, reason));
        let response = match read_response() {
            Ok(r) => r,
            Err(e) => return fail(self, &e),
        };
        if response.payload_hash != p.payload_hash {
            return fail(self, "the MPC signed another payload hash");
        }
        if !self.mpc_signed(&response, &p.payload_hash) {
            return fail(self, "invalid MPC signature");
        }
        let Some(schema_uid) = self.instruction_schema() else {
            return fail(self, "the foreignInstruction schema is not configured");
        };
        let forwarded = attestation_deposit(&p.subject, p.data.len());
        if forwarded > deposit {
            return fail(self, "the deposit does not cover the storage");
        }
        if !self.used_payloads.insert(uid) {
            return fail(self, "this instruction was already attested");
        }
        emit(
            events::FOREIGN_TX_VERIFIED,
            &json!({
                "payload_hash": uid, "chain": "solana", "tx_id": claim.tx_id,
                "instruction_index": claim.instruction_index, "inner_instruction_index": claim.inner_instruction_index,
                "program_id": claim.program_id, "subject": p.subject,
            }),
        );
        PromiseOrValue::Promise(
            self.attest(schema_uid, p.subject, p.data, None, forwarded).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_AFTER_ATTEST)
                    .with_unused_gas_weight(0)
                    .on_instruction_attested(claim.clone(), uid, requester.clone(), U128(deposit)),
            ),
        )
    }

    pub(crate) fn prepare_instruction(&self, claim: &ForeignInstructionClaim) -> Result<Prepared, String> {
        let tx_id: [u8; 64] = decode58(&claim.tx_id, "tx_id")?
            .try_into()
            .map_err(|_| "tx_id must be a 64-byte transaction signature".to_string())?;
        let program_id = key(&claim.program_id, "program_id")?;
        if claim.accounts.len() > MAX_ACCOUNTS {
            return Err(format!("an instruction has at most {MAX_ACCOUNTS} accounts"));
        }
        let accounts = claim.accounts.iter().map(|a| key(a, "accounts")).collect::<Result<Vec<_>, _>>()?;
        let data = decode58(&claim.data, "data")?;
        if data.len() > MAX_DATA_BYTES {
            return Err(format!("instruction data is at most {MAX_DATA_BYTES} bytes"));
        }
        let reference = if self.is_testnet() { SOLANA_DEVNET_REF } else { SOLANA_MAINNET_REF };
        let subject =
            claim.subject.clone().unwrap_or_else(|| format!("solana:{reference}:{}", claim.program_id));
        if !is_valid_subject(&subject) {
            return Err("subject must be a NEAR account id or a CAIP-10 account id".into());
        }
        let instruction = SvmInnerInstruction { program_id, accounts: accounts.clone(), data: data.clone() };
        let (request, payload_hash) = mpc::instruction_request(
            HexArray(tx_id),
            claim.instruction_index,
            claim.inner_instruction_index,
            &instruction,
        );
        // The `foreignInstruction` schema: string chain, bytes tx_id, u64 instruction_index,
        // u64 inner_instruction_index, bytes32 program_id, bytes32[] accounts, bytes data.
        let accounts: Vec<[u8; 32]> = accounts.iter().map(|a| a.0).collect();
        let data = borsh::to_vec(&(
            "solana",
            tx_id.to_vec(),
            claim.instruction_index,
            claim.inner_instruction_index,
            program_id.0,
            accounts,
            data,
        ))
        .expect("borsh");
        Ok(Prepared { request, payload_hash, subject, data })
    }

    fn instruction_failed(
        &self,
        claim: &ForeignInstructionClaim,
        payload_hash: Uid,
        reason: &str,
    ) -> Outcome {
        emit(
            events::FOREIGN_TX_FAILED,
            &json!({
                "payload_hash": payload_hash, "chain": "solana", "tx_id": claim.tx_id,
                "instruction_index": claim.instruction_index, "inner_instruction_index": claim.inner_instruction_index,
                "reason": reason,
            }),
        );
        Outcome::new(payload_hash, "failed")
    }
}

fn decode58(s: &str, what: &str) -> Result<Vec<u8>, String> {
    bs58::decode(s).into_vec().map_err(|_| format!("{what} must be base58"))
}

fn key(s: &str, what: &str) -> Result<mpc::Hash256, String> {
    let bytes: [u8; 32] =
        decode58(s, what)?.try_into().map_err(|_| format!("{what} must be 32-byte Solana addresses"))?;
    Ok(HexArray(bytes))
}

//! NEP-297 events. Every state change logs one line:
//! `EVENT_JSON:{"standard":"attestra","version":"1.0.0","event":"<name>","data":[{...}]}`.
//! The indexer reads these lines, and a light client proof of the receipt that logged a line
//! proves the event is in a final block.

use near_sdk::env;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json};

pub const STANDARD: &str = "attestra";
pub const VERSION: &str = "1.0.0";

pub fn emit<T: Serialize>(event: &str, data: &T) {
    let line = json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{}", serde_json::to_string(&line).expect("json")));
}

// Event names, shared with the indexer (apps/indexer/src/events.ts).
pub const SCHEMA_PENDING: &str = "schema_pending";
pub const SCHEMA_REGISTERED: &str = "schema_registered";
pub const SCHEMA_REJECTED: &str = "schema_rejected";
pub const BLOB_STORED: &str = "blob_stored";
pub const ATTESTATION_PENDING: &str = "attestation_pending";
pub const ATTESTATION_CREATED: &str = "attestation_created";
pub const ATTESTATION_REJECTED: &str = "attestation_rejected";
pub const ATTESTATION_REVOKED: &str = "attestation_revoked";
pub const ATTESTATION_EXPIRED: &str = "attestation_expired";
pub const REVOCATION_REJECTED: &str = "revocation_rejected";
pub const REVOCATION_SCHEDULED: &str = "revocation_scheduled";
pub const AUTHORITY_REGISTERED: &str = "authority_registered";
pub const AUTHORITY_VERIFIED: &str = "authority_verified";
pub const AUTHORITY_TIER: &str = "authority_tier";
pub const DELEGATE_ADDED: &str = "delegate_added";
pub const DELEGATE_REMOVED: &str = "delegate_removed";
pub const SIGNER_KEY_ADDED: &str = "signer_key_added";
pub const SIGNER_KEY_REMOVED: &str = "signer_key_removed";
pub const MULTISIG_CREATED: &str = "multisig_created";
pub const MULTISIG_PROPOSED: &str = "multisig_proposed";
pub const MULTISIG_APPROVED: &str = "multisig_approved";
pub const MULTISIG_EXECUTED: &str = "multisig_executed";
pub const MULTISIG_CANCELLED: &str = "multisig_cancelled";
pub const CREDENTIAL_MINTED: &str = "credential_minted";
pub const CREDENTIAL_BURNED: &str = "credential_burned";
pub const STAKE_CHANGED: &str = "stake_changed";
pub const RESOLVER_CONFIGURED: &str = "resolver_configured";
pub const FEE_CHARGED: &str = "fee_charged";
pub const FEE_REFUNDED: &str = "fee_refunded";
pub const REWARD_PAID: &str = "reward_paid";
/// A payer's prepaid fee balance was credited (NEAR `deposit` or an NEP-141 transfer).
pub const FEE_DEPOSITED: &str = "fee_deposited";
/// A payer took back unused prepaid fee balance.
pub const FEE_WITHDRAWN: &str = "fee_withdrawn";
/// A schema admin took the fees collected for a schema.
pub const FEES_CLAIMED: &str = "fees_claimed";
/// A schema's reward pool was funded.
pub const REWARD_FUNDED: &str = "reward_funded";
/// A schema admin took tokens back out of a reward pool.
pub const REWARD_POOL_WITHDRAWN: &str = "reward_pool_withdrawn";
pub const VERDICT_ACCEPTED: &str = "verdict_accepted";
pub const FOREIGN_TX_REQUESTED: &str = "foreign_tx_requested";
pub const FOREIGN_TX_VERIFIED: &str = "foreign_tx_verified";
pub const FOREIGN_TX_FAILED: &str = "foreign_tx_failed";
pub const WALLET_LINKED: &str = "wallet_linked";
pub const WALLET_LINK_REPLACED: &str = "wallet_link_replaced";

//! Attestra credentials: non-transferable NEP-171 tokens that mirror attestations.
//!
//! The attester or the subject of an active attestation mints its credential to the subject (a
//! NEAR account) with `mint`, which reads the attestation from the attestations contract and pays
//! the token's storage from the attached deposit. The token id is the attestation UID in hex.
//! When the attestation is revoked or its expiry is recorded, the attestations contract calls
//! `on_attestation_revoked` and the credential is burned. The storage it freed stays with this
//! contract. A revocation that arrives while a mint is between its read and its callback marks
//! that mint, which then refuses. A credential past its attestation's expiry is gone from every
//! view at once (like the attestation, whose expiry is computed on read), and anyone may burn it
//! with `burn_expired`. The holder may burn a credential they do not want with `nft_burn`.
//!
//! Transfers and approvals are disabled; the enumeration and metadata views follow NEP-171,
//! NEP-177 and NEP-181.

#[cfg(test)]
mod tests;

use attestra_common::events::{emit, CREDENTIAL_BURNED, CREDENTIAL_MINTED};
use attestra_common::{near_subject, Uid};
use near_contract_standards::non_fungible_token::core::NonFungibleTokenCore;
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::{NftBurn, NftMint};
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue,
};

const NON_TRANSFERABLE: &str = "credentials are non-transferable";
/// `get_attestation` on the attestations contract.
const GAS_GET_ATTESTATION: Gas = Gas::from_tgas(15);
/// `mint_checked`: parses the attestation, mints and refunds.
const GAS_MINT_CALLBACK: Gas = Gas::from_tgas(30);
/// Largest `get_attestation` answer read (the payload is at most 16 KiB before base64).
const MAX_ATTESTATION_JSON: usize = 64 * 1024;

/// The fields of the attestations contract's `AttestationView` this contract reads.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct AttestationView {
    pub uid: Uid,
    pub schema_uid: Uid,
    pub attester: AccountId,
    pub subject: String,
    pub created_at: u64,
    pub expiration_time: u64,
    /// `pending`, `active`, `revoking`, `revoked` or `expired`.
    pub status: String,
}

#[ext_contract(ext_attestations_view)]
pub trait AttestationsView {
    fn get_attestation(&self, uid: Uid);
}

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    OwnerById,
    TokenMetadata,
    Enumeration,
    Minting,
}

/// Mints of one attestation between `mint` and `mint_checked`.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Minting {
    pub in_flight: u32,
    /// The attestation was revoked while a mint was in flight.
    pub revoked: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    attestations: AccountId,
    tokens: NonFungibleToken,
    metadata: NFTContractMetadata,
    minting: LookupMap<Uid, Minting>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, attestations: AccountId) -> Self {
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Attestra Credentials".to_string(),
            symbol: "ATTEST".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        metadata.assert_valid();
        Self {
            attestations,
            tokens: NonFungibleToken::new(
                Key::OwnerById,
                owner,
                Some(Key::TokenMetadata),
                Some(Key::Enumeration),
                None::<Key>,
            ),
            metadata,
            minting: LookupMap::new(Key::Minting),
        }
    }

    /// Mints the credential of `attestation_uid` to its subject. Callable by the attester or the
    /// subject while the attestation is active; the attached deposit pays the storage and the rest
    /// is refunded. Resolves to the token, or to null with the whole deposit refunded.
    #[payable]
    pub fn mint(&mut self, attestation_uid: Uid) -> Promise {
        let deposit = env::attached_deposit();
        require!(!deposit.is_zero(), "attach a deposit to pay for the credential storage");
        require!(
            self.tokens.owner_by_id.get(&attestation_uid.to_hex()).is_none(),
            "a credential already exists for this attestation"
        );
        let entry = self.minting.entry(attestation_uid).or_default();
        entry.in_flight += 1;
        ext_attestations_view::ext(self.attestations.clone())
            .with_static_gas(GAS_GET_ATTESTATION)
            .with_unused_gas_weight(0)
            .get_attestation(attestation_uid)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_MINT_CALLBACK).mint_checked(
                attestation_uid,
                env::predecessor_account_id(),
                U128(deposit.as_yoctonear()),
            ))
    }

    /// Mints once the attestation is read. Never panics: on any failure it logs why, refunds the
    /// whole deposit to `minter` and returns null.
    #[private]
    pub fn mint_checked(&mut self, attestation_uid: Uid, minter: AccountId, deposit: U128) -> Option<Token> {
        let revoked = self.finish_minting(attestation_uid);
        let minted = if revoked {
            Err("the attestation was revoked while the credential was being minted".to_string())
        } else {
            self.try_mint(attestation_uid, &minter, deposit.0)
        };
        match minted {
            Ok(token) => Some(token),
            Err(reason) => {
                log!("credential not minted: {reason}");
                refund(&minter, deposit.0);
                None
            }
        }
    }

    /// Burns the credential of a revoked attestation, if one was minted.
    pub fn on_attestation_revoked(&mut self, attestation_uid: Uid) {
        require!(
            env::predecessor_account_id() == self.attestations,
            "only the attestations contract can burn credentials"
        );
        if let Some(m) = self.minting.get_mut(&attestation_uid) {
            m.revoked = true;
        }
        self.burn_and_log(&attestation_uid.to_hex(), "revoked");
    }

    pub fn credential_for_attestation(&self, attestation_uid: Uid) -> Option<Token> {
        self.nft_token(attestation_uid.to_hex())
    }

    /// Burns a credential whose attestation has expired. Anyone may call it (the keeper does).
    pub fn burn_expired(&mut self, token_id: TokenId) -> bool {
        let Some(token) = self.tokens.nft_token(token_id.clone()) else { return false };
        require!(expired(&token), "the credential has not expired");
        self.burn_and_log(&token_id, "expired");
        true
    }

    /// The holder burns their own credential: an attester can issue one to anyone, and the
    /// holder can always refuse it. The attestation itself is untouched.
    pub fn nft_burn(&mut self, token_id: TokenId) {
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("no such credential"));
        require!(env::predecessor_account_id() == owner, "only the holder can burn a credential");
        self.burn_and_log(&token_id, "burned by the holder");
    }

    // NEP-171: transfers and approvals are disabled.

    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        let _ = (receiver_id, token_id, approval_id, memo);
        env::panic_str(NON_TRANSFERABLE)
    }

    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        let _ = (receiver_id, token_id, approval_id, memo, msg);
        env::panic_str(NON_TRANSFERABLE)
    }

    #[payable]
    pub fn nft_approve(&mut self, token_id: TokenId, account_id: AccountId, msg: Option<String>) {
        let _ = (token_id, account_id, msg);
        env::panic_str(NON_TRANSFERABLE)
    }

    #[payable]
    pub fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        let _ = (token_id, account_id);
        env::panic_str(NON_TRANSFERABLE)
    }

    #[payable]
    pub fn nft_revoke_all(&mut self, token_id: TokenId) {
        let _ = token_id;
        env::panic_str(NON_TRANSFERABLE)
    }

    /// Always false: credentials have no approvals.
    pub fn nft_is_approved(
        &self,
        token_id: TokenId,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        let _ = (token_id, approved_account_id, approval_id);
        false
    }

    // NEP-171, NEP-177 and NEP-181 views.

    /// The credential, or null once burned or past its attestation's expiry.
    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id).filter(|t| !expired(t))
    }

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.clone()
    }

    pub fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    /// Live credentials; expired ones are left out (the supply counts them until they are burned).
    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit).into_iter().filter(|t| !expired(t)).collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit).into_iter().filter(|t| !expired(t)).collect()
    }
}

impl Contract {
    /// Counts one in-flight mint of `uid` as done and returns whether the attestation was revoked
    /// while it was in flight. The record goes once no mint is in flight.
    fn finish_minting(&mut self, uid: Uid) -> bool {
        let Some(m) = self.minting.get_mut(&uid) else { return false };
        let revoked = m.revoked;
        m.in_flight = m.in_flight.saturating_sub(1);
        if m.in_flight == 0 {
            self.minting.remove(&uid);
        }
        revoked
    }

    fn try_mint(&mut self, attestation_uid: Uid, minter: &AccountId, deposit: u128) -> Result<Token, String> {
        let attestation = read_attestation()?;
        if attestation.uid != attestation_uid {
            return Err("the attestations contract answered with another attestation".into());
        }
        if attestation.status != "active" {
            return Err(format!("the attestation is {}", attestation.status));
        }
        if *minter != attestation.attester && minter.as_str() != attestation.subject {
            return Err(format!("{minter} is neither the attester nor the subject"));
        }
        let owner_id = near_subject(&attestation.subject)
            .ok_or_else(|| format!("the subject {} is not a NEAR account", attestation.subject))?;
        let token_id = attestation_uid.to_hex();
        if self.tokens.owner_by_id.get(&token_id).is_some() {
            return Err("a credential already exists for this attestation".into());
        }

        let before = env::storage_usage();
        let token = self.tokens.internal_mint_with_refund(
            token_id.clone(),
            owner_id.clone(),
            Some(credential_metadata(&attestation)),
            None,
        );
        let cost =
            env::storage_usage().saturating_sub(before) as u128 * env::storage_byte_cost().as_yoctonear();
        if cost > deposit {
            self.burn(&token_id);
            return Err(format!("attach at least {cost} yoctoNEAR to cover the storage"));
        }
        refund(minter, deposit - cost);

        NftMint { owner_id: &owner_id, token_ids: &[&token_id], memo: None }.emit();
        emit(
            CREDENTIAL_MINTED,
            &json!({
                "token_id": token_id,
                "attestation_uid": attestation_uid,
                "schema_uid": attestation.schema_uid,
                "owner_id": owner_id,
                "attester": attestation.attester,
                "minter": minter,
            }),
        );
        Ok(token)
    }

    /// Burns a token, if it exists, and logs the NEP-171 burn and the Attestra event.
    fn burn_and_log(&mut self, token_id: &TokenId, memo: &str) {
        let Some(owner_id) = self.burn(token_id) else { return };
        NftBurn { owner_id: &owner_id, token_ids: &[token_id], authorized_id: None, memo: Some(memo) }.emit();
        emit(
            CREDENTIAL_BURNED,
            &json!({ "token_id": token_id, "attestation_uid": token_id, "owner_id": owner_id, "reason": memo }),
        );
    }

    /// Removes a token from every map of the NFT and returns its owner.
    fn burn(&mut self, token_id: &TokenId) -> Option<AccountId> {
        let owner_id = self.tokens.owner_by_id.remove(token_id)?;
        if let Some(metadata) = self.tokens.token_metadata_by_id.as_mut() {
            metadata.remove(token_id);
        }
        if let Some(per_owner) = self.tokens.tokens_per_owner.as_mut() {
            if let Some(mut ids) = per_owner.get(&owner_id) {
                ids.remove(token_id);
                if ids.is_empty() {
                    per_owner.remove(&owner_id);
                } else {
                    per_owner.insert(&owner_id, &ids);
                }
            }
        }
        if let Some(approvals) = self.tokens.approvals_by_id.as_mut() {
            approvals.remove(token_id);
        }
        if let Some(next_ids) = self.tokens.next_approval_id_by_id.as_mut() {
            next_ids.remove(token_id);
        }
        Some(owner_id)
    }
}

/// The attestation returned by `get_attestation`, or why it cannot be used.
fn read_attestation() -> Result<AttestationView, String> {
    if env::promise_results_count() != 1 {
        return Err("expected one promise result".into());
    }
    let bytes = env::promise_result_checked(0, MAX_ATTESTATION_JSON)
        .map_err(|_| "the attestation could not be read".to_string())?;
    let view: Option<AttestationView> =
        serde_json::from_slice(&bytes).map_err(|_| "the attestation could not be parsed".to_string())?;
    view.ok_or_else(|| "the attestation does not exist".to_string())
}

/// NEP-177 token metadata; times are Unix milliseconds as strings.
fn credential_metadata(a: &AttestationView) -> TokenMetadata {
    let millis = |secs: u64| secs.saturating_mul(1000).to_string();
    TokenMetadata {
        title: Some("Attestra credential".to_string()),
        description: Some(format!("Attestation under schema {} issued by {}", a.schema_uid, a.attester)),
        media: None,
        media_hash: None,
        copies: None,
        issued_at: Some(millis(a.created_at)),
        expires_at: (a.expiration_time > 0).then(|| millis(a.expiration_time)),
        starts_at: None,
        updated_at: None,
        extra: Some(
            json!({ "schema_uid": a.schema_uid, "attester": a.attester, "attestation_uid": a.uid })
                .to_string(),
        ),
        reference: None,
        reference_hash: None,
    }
}

/// Past the expiry its metadata carries (Unix milliseconds, from the attestation).
fn expired(token: &Token) -> bool {
    token
        .metadata
        .as_ref()
        .and_then(|m| m.expires_at.as_deref())
        .and_then(|ms| ms.parse::<u64>().ok())
        .is_some_and(|ms| env::block_timestamp_ms() >= ms)
}

fn refund(account_id: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(account_id.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
    }
}

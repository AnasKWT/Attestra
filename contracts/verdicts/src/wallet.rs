//! Wallet links: a NEAR account proves it controls an Ethereum or Solana wallet.

use crate::*;
use attestra_common::events::{self, emit};
use near_sdk::borsh;
use near_sdk::serde_json::json;

const SOLANA_MAINNET: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/// A wallet in canonical form.
struct Wallet {
    /// `eip155` or `solana`.
    chain: &'static str,
    /// Lowercase `0x` address, or the base58 Solana address.
    address: String,
    caip10: String,
    /// The 20 address bytes (eip155) or the 32-byte ed25519 key (solana).
    bytes: Vec<u8>,
}

/// What a link writes here: `links[caip10] = account` and `link_nonces[account]`.
fn link_storage_bytes(account_id: &AccountId, caip10: &str) -> u64 {
    let link = 1 + 4 + caip10.len() + 4 + account_id.len();
    let nonce = 1 + 4 + account_id.len() + 8;
    (link + nonce) as u64 + 2 * RECORD_OVERHEAD_BYTES
}

/// The `wallet_link` attestation data: `string chain, string address, string caip10`.
fn link_data(wallet: &Wallet) -> Vec<u8> {
    borsh::to_vec(&(wallet.chain, &wallet.address, &wallet.caip10)).expect("borsh")
}

/// The deposit `link_wallet` takes: the link here and its attestation there.
fn link_deposit(account_id: &AccountId, wallet: &Wallet) -> (u128, u128) {
    let local = storage_cost(link_storage_bytes(account_id, &wallet.caip10));
    (local, attestation_deposit(account_id.as_str(), link_data(wallet).len()))
}

fn parse_wallet(chain: &str, address: &str) -> Wallet {
    match chain {
        "eip155" => {
            let bytes = crypto::parse_eth_address(address)
                .unwrap_or_else(|| env::panic_str("an eip155 address is 0x followed by 40 hex characters"));
            let address = format!("0x{}", hex::encode(bytes));
            Wallet { chain: "eip155", caip10: format!("eip155:1:{address}"), address, bytes: bytes.to_vec() }
        }
        "solana" => {
            let bytes: [u8; 32] = near_sdk::bs58::decode(address)
                .into_vec()
                .ok()
                .and_then(|b| b.try_into().ok())
                .unwrap_or_else(|| env::panic_str("a solana address is the base58 of 32 bytes"));
            let address = near_sdk::bs58::encode(bytes).into_string();
            Wallet {
                chain: "solana",
                caip10: format!("solana:{SOLANA_MAINNET}:{address}"),
                address,
                bytes: bytes.to_vec(),
            }
        }
        _ => env::panic_str("chain must be eip155 or solana"),
    }
}

/// A Solana signature: 64 bytes as hex (optional `0x`) or base58.
fn parse_solana_signature(s: &str) -> Option<[u8; 64]> {
    let bare = s.strip_prefix("0x").unwrap_or(s);
    if bare.len() == 128 && bare.bytes().all(|c| c.is_ascii_hexdigit()) {
        return crypto::decode_hex_array(bare);
    }
    near_sdk::bs58::decode(s).into_vec().ok()?.try_into().ok()
}

#[near]
impl Contract {
    /// The exact text the wallet signs to link to `account_id`.
    pub fn link_message(&self, account_id: AccountId, chain: String, address: String) -> String {
        let wallet = parse_wallet(&chain, &address);
        self.message(&account_id, &wallet)
    }

    /// The deposit `link_wallet` needs from `account_id` for this wallet, in yoctoNEAR.
    pub fn link_wallet_deposit(&self, account_id: AccountId, chain: String, address: String) -> U128 {
        let (local, remote) = link_deposit(&account_id, &parse_wallet(&chain, &address));
        U128(local + remote)
    }

    /// Links a wallet to the caller after checking the wallet's signature over `link_message`
    /// (`personal_sign` for eip155, a raw ed25519 message signature for solana), and attests it
    /// under the `wallet_link` schema with the caller as subject. Attach 300 TGas and at least
    /// `link_wallet_deposit` (the rest is refunded): it pays for the link and the attestation.
    #[payable]
    pub fn link_wallet(&mut self, chain: String, address: String, signature: String) -> Promise {
        let schema_uid = self.schemas().wallet_link;
        require_gas();
        let caller = env::predecessor_account_id();
        let wallet = parse_wallet(&chain, &address);
        let message = self.message(&caller, &wallet);
        let valid = match wallet.chain {
            "eip155" => {
                let sig = crypto::decode_hex(&signature)
                    .filter(|s| s.len() == 65)
                    .unwrap_or_else(|| env::panic_str("an eip155 signature is 65 bytes of hex"));
                crypto::recover_personal_sign(message.as_bytes(), &sig).map(|a| a.to_vec())
                    == Some(wallet.bytes.clone())
            }
            _ => {
                let sig = parse_solana_signature(&signature)
                    .unwrap_or_else(|| env::panic_str("a solana signature is 64 bytes, hex or base58"));
                let key: [u8; 32] = wallet.bytes.as_slice().try_into().expect("32 bytes");
                env::ed25519_verify(&sig, message.as_bytes(), &key)
            }
        };
        require!(valid, "invalid wallet signature");
        let (local, remote) = link_deposit(&caller, &wallet);
        take_deposit(local + remote, "the wallet link and its attestation");

        let nonce = self.link_nonce(caller.clone());
        self.link_nonces.insert(caller.clone(), nonce + 1);
        let previous = self.links.insert(wallet.caip10.clone(), caller.clone()).filter(|p| p != &caller);
        emit(
            events::WALLET_LINKED,
            &json!({
                "account_id": caller, "chain": wallet.chain, "address": wallet.address, "caip10": wallet.caip10,
                "nonce": nonce, "previous": previous,
            }),
        );
        self.attest(schema_uid, caller.to_string(), link_data(&wallet), None, remote)
    }

    /// The NEAR account a wallet (CAIP-10 id, as `link_message` writes it) is linked to.
    pub fn linked_account(&self, caip10: String) -> Option<AccountId> {
        self.links.get(&caip10).cloned()
    }

    /// The nonce the next link message of `account_id` carries.
    pub fn link_nonce(&self, account_id: AccountId) -> u64 {
        self.link_nonces.get(&account_id).copied().unwrap_or(0)
    }
}

impl Contract {
    fn message(&self, account_id: &AccountId, wallet: &Wallet) -> String {
        format!(
            "Attestra wallet link\nNEAR account: {account_id}\nWallet: {}\nVerifier: {}\nNonce: {}",
            wallet.caip10,
            near_sdk::env::current_account_id(),
            self.link_nonce(account_id.clone())
        )
    }
}

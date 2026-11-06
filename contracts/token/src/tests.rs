use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const SUPPLY: u128 = 1_000_000 * 1_000_000_000_000_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn me() -> AccountId {
    acc("token.testnet")
}
fn alice() -> AccountId {
    acc("alice.testnet")
}
fn bob() -> AccountId {
    acc("bob.testnet")
}

fn context(predecessor: &AccountId, deposit: u128, secs: u64) -> near_sdk::VMContext {
    VMContextBuilder::new()
        .current_account_id(me())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(secs * 1_000_000_000)
        .build()
}

fn ctx(predecessor: &AccountId, deposit: u128) {
    testing_env!(context(predecessor, deposit, 1_700_000_000));
}

fn ctx_at(predecessor: &AccountId, secs: u64) {
    testing_env!(context(predecessor, 0, secs));
}

fn setup() -> Contract {
    ctx(&owner(), 0);
    Contract::new(owner(), U128(SUPPLY))
}

fn min_storage(c: &Contract) -> u128 {
    c.storage_balance_bounds().min.as_yoctonear()
}

fn transfers() -> Vec<(AccountId, u128)> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::Transfer { deposit, .. } = action {
                out.push((receipt.receiver_id.clone(), deposit.as_yoctonear()));
            }
        }
    }
    out
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn init_mints_the_supply_to_the_owner() {
    let c = setup();
    let m = c.ft_metadata();
    assert_eq!(m.spec, "ft-1.0.0");
    assert_eq!(m.name, "Attestra Test Token");
    assert_eq!(m.symbol, "tATT");
    assert_eq!(m.decimals, 18);
    assert_eq!(c.ft_total_supply(), U128(SUPPLY));
    assert_eq!(c.ft_balance_of(owner()), U128(SUPPLY));
    assert!(c.storage_balance_of(owner()).is_some());
    let e = events();
    assert_eq!(e[0]["standard"], "nep141");
    assert_eq!(e[0]["event"], "ft_mint");
    assert_eq!(e[0]["data"][0]["owner_id"], "owner.testnet");
    assert_eq!(e[0]["data"][0]["amount"], SUPPLY.to_string());
}

#[test]
fn init_with_no_supply() {
    ctx(&owner(), 0);
    let c = Contract::new(owner(), U128(0));
    assert_eq!(c.ft_total_supply(), U128(0));
    assert!(c.storage_balance_of(owner()).is_some());
    assert!(events().is_empty());
}

#[test]
fn faucet_registers_and_mints() {
    let mut c = setup();
    ctx(&alice(), 0);
    assert!(c.storage_balance_of(alice()).is_none());
    let before = env::storage_usage();
    assert_eq!(c.faucet(), U128(FAUCET_AMOUNT));
    assert!(env::storage_usage() > before);
    assert_eq!(FAUCET_AMOUNT, 1_000 * 10u128.pow(18));
    assert_eq!(c.ft_balance_of(alice()), U128(FAUCET_AMOUNT));
    assert_eq!(c.ft_total_supply(), U128(SUPPLY + FAUCET_AMOUNT));
    assert!(c.storage_balance_of(alice()).is_some());
    let e = events();
    assert_eq!(e[0]["event"], "ft_mint");
    assert_eq!(e[0]["data"][0]["memo"], "faucet");
    assert!(transfers().is_empty());
}

#[test]
fn faucet_once_an_hour() {
    let mut c = setup();
    ctx_at(&alice(), 1_000_000);
    c.faucet();
    ctx_at(&alice(), 1_000_000 + FAUCET_COOLDOWN_SECS);
    c.faucet();
    assert_eq!(c.ft_balance_of(alice()), U128(2 * FAUCET_AMOUNT));
    // Another account has its own clock.
    ctx_at(&bob(), 1_000_000 + FAUCET_COOLDOWN_SECS);
    c.faucet();
    assert_eq!(c.ft_balance_of(bob()), U128(FAUCET_AMOUNT));
}

#[test]
#[should_panic(expected = "the faucet can be used once an hour; try again in 1 seconds")]
fn faucet_rejects_an_early_claim() {
    let mut c = setup();
    ctx_at(&alice(), 1_000_000);
    c.faucet();
    ctx_at(&alice(), 1_000_000 + FAUCET_COOLDOWN_SECS - 1);
    c.faucet();
}

#[test]
fn faucet_keeps_an_existing_registration() {
    let mut c = setup();
    ctx(&alice(), NEAR);
    c.storage_deposit(None, None);
    ctx(&alice(), 0);
    c.faucet();
    // alice paid for her own registration, so unregistering refunds it.
    ctx(&alice(), 1);
    c.ft_transfer(owner(), U128(FAUCET_AMOUNT), None);
    ctx(&alice(), 1);
    assert!(c.storage_unregister(None));
    assert_eq!(transfers(), vec![(alice(), min_storage(&c) + 1)]);
}

#[test]
fn owner_mints() {
    let mut c = setup();
    ctx(&owner(), 0);
    c.mint(bob(), U128(42));
    assert_eq!(c.ft_balance_of(bob()), U128(42));
    assert_eq!(c.ft_total_supply(), U128(SUPPLY + 42));
    assert_eq!(events()[0]["data"][0]["memo"], "mint");
    // Minting to a registered account does not register it again.
    ctx(&owner(), 0);
    c.mint(owner(), U128(1));
    assert_eq!(c.ft_balance_of(owner()), U128(SUPPLY + 1));
}

#[test]
#[should_panic(expected = "only the owner can mint")]
fn mint_requires_the_owner() {
    let mut c = setup();
    ctx(&alice(), 0);
    c.mint(alice(), U128(42));
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn mint_requires_an_amount() {
    let mut c = setup();
    ctx(&owner(), 0);
    c.mint(alice(), U128(0));
}

#[test]
fn transfers_between_accounts() {
    let mut c = setup();
    ctx(&bob(), NEAR);
    c.storage_deposit(None, Some(true));
    ctx(&owner(), 1);
    c.ft_transfer(bob(), U128(500), Some("hi".into()));
    assert_eq!(c.ft_balance_of(bob()), U128(500));
    assert_eq!(c.ft_balance_of(owner()), U128(SUPPLY - 500));
    let e = events();
    assert_eq!(e[0]["event"], "ft_transfer");
    assert_eq!(e[0]["data"][0]["memo"], "hi");
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn transfer_requires_one_yocto() {
    let mut c = setup();
    ctx(&owner(), 0);
    c.ft_transfer(bob(), U128(500), None);
}

#[test]
#[should_panic(expected = "The account bob.testnet is not registered")]
fn transfer_to_an_unregistered_account() {
    let mut c = setup();
    ctx(&owner(), 1);
    c.ft_transfer(bob(), U128(500), None);
}

#[test]
fn transfer_call_and_resolve() {
    let mut c = setup();
    let receiver = acc("staking.testnet");
    ctx(&owner(), NEAR);
    c.storage_deposit(Some(receiver.clone()), None);
    ctx(&owner(), 1);
    let _ = c.ft_transfer_call(receiver.clone(), U128(300), None, "stake".into());
    assert_eq!(c.ft_balance_of(receiver.clone()), U128(300));
    let receipts = get_created_receipts();
    let methods: Vec<_> = receipts
        .iter()
        .flat_map(|r| {
            r.actions.iter().filter_map(|a| match a {
                MockAction::FunctionCallWeight { method_name, .. } => {
                    Some((r.receiver_id.clone(), String::from_utf8(method_name.clone()).unwrap()))
                }
                _ => None,
            })
        })
        .collect();
    assert_eq!(
        methods,
        vec![(receiver.clone(), "ft_on_transfer".to_string()), (me(), "ft_resolve_transfer".to_string())]
    );

    // The receiver used 200 and returned 100.
    testing_env!(
        context(&me(), 0, 1_700_000_000),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(serde_json::to_vec(&U128(100)).unwrap())]
    );
    assert_eq!(c.ft_resolve_transfer(owner(), receiver.clone(), U128(300)), U128(200));
    assert_eq!(c.ft_balance_of(receiver), U128(200));
    assert_eq!(c.ft_balance_of(owner()), U128(SUPPLY - 200));
}

#[test]
fn storage_deposit_and_bounds() {
    let mut c = setup();
    let min = min_storage(&c);
    assert!(min > 0);
    assert_eq!(c.storage_balance_bounds().max.map(|m| m.as_yoctonear()), Some(min));
    ctx(&alice(), min + 7);
    let balance = c.storage_deposit(None, None);
    assert_eq!(balance.total.as_yoctonear(), min);
    assert_eq!(transfers(), vec![(alice(), 7)]);
    // A second deposit is refunded in full.
    ctx(&alice(), 5);
    c.storage_deposit(None, None);
    assert_eq!(transfers(), vec![(alice(), 5)]);
    // Withdrawing nothing returns the balance.
    ctx(&alice(), 1);
    assert_eq!(c.storage_withdraw(None).total.as_yoctonear(), min);
}

#[test]
#[should_panic(expected = "The attached deposit is less than the minimum storage balance")]
fn storage_deposit_below_the_minimum() {
    let mut c = setup();
    ctx(&alice(), 1);
    c.storage_deposit(None, None);
}

#[test]
#[should_panic(expected = "The amount is greater than the available storage balance")]
fn storage_withdraw_has_nothing_available() {
    let mut c = setup();
    ctx(&owner(), 1);
    c.storage_withdraw(Some(NearToken::from_yoctonear(1)));
}

#[test]
fn faucet_accounts_get_no_storage_refund() {
    let mut c = setup();
    ctx(&alice(), 0);
    c.faucet();
    ctx(&alice(), 1);
    assert!(c.storage_unregister(Some(true)));
    assert_eq!(transfers(), vec![(alice(), 1)]);
    assert!(c.storage_balance_of(alice()).is_none());
    assert_eq!(c.ft_total_supply(), U128(SUPPLY));
    let e = events();
    assert_eq!(e[0]["event"], "ft_burn");
    assert_eq!(e[0]["data"][0]["amount"], FAUCET_AMOUNT.to_string());
}

#[test]
#[should_panic(expected = "the faucet can be used once an hour")]
fn faucet_clock_survives_unregistering() {
    let mut c = setup();
    ctx(&alice(), 0);
    c.faucet();
    ctx(&alice(), 1);
    c.storage_unregister(Some(true));
    ctx(&alice(), 0);
    c.faucet();
}

#[test]
fn self_registered_accounts_get_the_storage_back() {
    let mut c = setup();
    let min = min_storage(&c);
    ctx(&alice(), min);
    c.storage_deposit(None, None);
    ctx(&alice(), 1);
    assert!(c.storage_unregister(None));
    assert_eq!(transfers(), vec![(alice(), min + 1)]);
    // Unregistering twice is a no-op.
    ctx(&alice(), 1);
    assert!(!c.storage_unregister(None));
    assert!(transfers().is_empty());
}

#[test]
#[should_panic(expected = "Can't unregister the account with the positive balance without force")]
fn unregister_with_a_balance_needs_force() {
    let mut c = setup();
    ctx(&alice(), 0);
    c.faucet();
    ctx(&alice(), 1);
    c.storage_unregister(None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn unregister_requires_one_yocto() {
    let mut c = setup();
    ctx(&alice(), 0);
    c.faucet();
    ctx(&alice(), 0);
    c.storage_unregister(Some(true));
}

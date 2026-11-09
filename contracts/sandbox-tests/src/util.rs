//! Small helpers: NEP-297 events, failure checks, chain time and amounts.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Worker;
use serde_json::Value;

/// Gas every call attaches: what wallets and the SDK attach, and what the contracts document.
pub const TX_GAS: Gas = Gas::from_tgas(300);

/// One whole tATT (18 decimals) as a yocto amount.
pub const TOKEN: u128 = 1_000_000_000_000_000_000;

pub fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

pub fn millinear(n: u128) -> NearToken {
    NearToken::from_millinear(n)
}

pub fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

/// `n` whole tATT in JSON form (a decimal string).
pub fn tokens(n: u128) -> String {
    (n * TOKEN).to_string()
}

/// Every NEP-297 event of `standard` named `event` the transaction logged, as its `data[0]`.
pub fn nep297(result: &ExecutionFinalResult, standard: &str, event: &str) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .filter_map(|json| serde_json::from_str::<Value>(json).ok())
        .filter(|v| v["standard"] == standard && v["event"] == event)
        .map(|v| v["data"][0].clone())
        .collect()
}

/// Attestra events named `event`.
pub fn events(result: &ExecutionFinalResult, event: &str) -> Vec<Value> {
    nep297(result, "attestra", event)
}

/// The single Attestra event named `event`; panics when there is not exactly one.
pub fn event(result: &ExecutionFinalResult, event: &str) -> Value {
    let found = events(result, event);
    assert_eq!(found.len(), 1, "expected one {event} event, got {found:?}\nlogs: {:#?}", result.logs());
    found.into_iter().next().expect("one")
}

/// Asserts the transaction and every receipt it spawned succeeded, and returns it.
#[track_caller]
pub fn ok(result: ExecutionFinalResult) -> ExecutionFinalResult {
    assert!(result.is_success(), "transaction failed: {:#?}", result.failures());
    assert!(result.receipt_failures().is_empty(), "a receipt failed: {:#?}", result.receipt_failures());
    result
}

/// Asserts the transaction failed with a message containing `needle`.
#[track_caller]
pub fn fails_with(result: ExecutionFinalResult, needle: &str) {
    assert!(
        result.is_failure(),
        "expected a failure containing {needle:?}, got success: {:#?}",
        result.logs()
    );
    let text = format!("{:?}", result.failures());
    assert!(text.contains(needle), "expected a failure containing {needle:?}, got {text}");
}

/// Asserts some receipt of the transaction failed with a message containing `needle`.
#[track_caller]
pub fn receipt_failed_with(result: &ExecutionFinalResult, needle: &str) {
    let text = format!("{:?}", result.receipt_failures());
    assert!(text.contains(needle), "expected a receipt failure containing {needle:?}, got {text}");
}

/// Block time of the latest block, in seconds.
pub async fn chain_secs(worker: &Worker<Sandbox>) -> anyhow::Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000_000)
}

/// Fast-forwards blocks until the latest block is later than `secs`.
pub async fn advance_past(worker: &Worker<Sandbox>, secs: u64) -> anyhow::Result<()> {
    for _ in 0..200 {
        if chain_secs(worker).await? > secs {
            return Ok(());
        }
        worker.fast_forward(5).await?;
    }
    anyhow::bail!("the chain did not reach {secs}")
}

/// A yocto amount from its JSON form (`U128` as a string).
pub fn u128_of(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("expected a U128 string, got {v}")).parse().expect("u128")
}

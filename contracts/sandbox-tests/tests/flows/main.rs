//! Cross-contract flows on the sandbox. Each test starts its own sandbox with every contract
//! deployed and wired (`Env::new`), so the tests are independent and run fine one at a time
//! (`--test-threads=1`).

mod attest;
mod credentials;
mod delegation;
mod resolvers;
mod schemas;
mod signed;
mod staking;
mod storage;
mod verdicts;

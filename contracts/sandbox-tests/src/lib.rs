//! End-to-end tests of the Attestra contracts on a local NEAR sandbox.
//!
//! `setup::Env::new` starts a sandbox, deploys every contract as a sub-account of
//! `attestra.test.near` and wires them together the way production does. The tests in
//! `tests/flows` drive each cross-contract flow and check the outcome through views and the
//! NEP-297 events. Build the wasm files first with `build.sh`.

pub mod crypto;
pub mod setup;
pub mod util;

pub use setup::Env;

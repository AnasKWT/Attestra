# Security

Attestra's contracts hold storage balances, prepaid fees, reward pools and staked tokens, and they decide which facts NEAR accepts as attested.
This file records how they were reviewed, what was found and fixed, the design decisions behind them, and how to check it yourself.

## How to check

```bash
pnpm security          # Clippy -D warnings, cargo audit, cargo deny on the wasm graph, pnpm audit
pnpm test:contracts    # 323 unit and property tests
pnpm test:sandbox      # 20 near-workspaces flows across every contract (build first: contracts/scripts/build.sh)
```

`cargo audit` ignores three advisories, each with a reason in `scripts/security.ts`:
- RUSTSEC-2026-0387 (crypto-bigint): reaches only test tooling (near-sdk's unit-testing VM and the k256 test signatures);
- RUSTSEC-2024-0449 (unsafe-libyaml): reaches only near-workspaces;
- RUSTSEC-2022-0054 (wee_alloc, unmaintained): near-sdk's default allocator; each call starts with fresh memory.

`cargo deny` checks the dependency graph the chain actually runs (wasm target, no dev dependencies) for advisories, licenses and sources.

## Review

All seven contracts (and the five resolver kinds in one of them) were reviewed against the NEAR contract audit checklist (the `near-contract-audit` agent skill): cross-contract calls and callbacks, state ordering around promises, gas sizing, deposit refunds, access control, NEP-145 storage accounting, NEP-413 replay, multisig thresholds, token accounting, signature verification (ed25519, EIP-191 with `ecrecover`, the MPC foreign-transaction payload hash), integer overflow, unbounded iteration and storage key collisions.
Every finding below has a regression unit test that reproduces its scenario.
The near-workspaces flows separately found a gas-budget bug (G-1).

## Findings and fixes

| ID | Severity | Contract | Problem | Fix |
|---|---|---|---|---|
| F-1 | High | verdicts | `link_wallet` and `attest_foreign_event` created attestations paid from the verdicts contract's own storage balance, so anyone could drain it and stop every verdict flow. | Both are payable and require a deposit equal to the storage they cause (views `link_wallet_deposit`, `foreign_event_deposit`); the share for the attestation is forwarded with `attest`; failures refund it. |
| F-2 | High | resolvers (fee) | Any account could pose as a token through `ft_on_transfer` and create balance entries the resolver pays for, locking its NEAR until fee schemas stopped working. | The owner lists accepted fee tokens (`add_fee_token`, `remove_fee_token`); transfers from other tokens are refunded in full. |
| F-3 | Medium | credentials | A revocation landing between a mint's read and its callback left a credential for a revoked attestation that was never burned. | In-flight mints are tracked; a revocation marks them and the callback refuses and refunds. |
| G-1 | Medium | attestations | The commit callback always had a fixed gas budget, so a token reward inside a pipeline of 3 or 4 resolvers was silently never paid. | Gas attached beyond the resolver call's cap now reaches the commit callback and `on_committed`. |
| F-4 | Low | attestations | A pending operation stored a second copy of the payload at the contract's expense. | The pending entry keeps only the fields the callback needs. |
| F-5 | Low | attestations | A scheduled revocation finalized while a direct revocation was pending was logged twice. | `apply_revoke` does nothing for an attestation already revoked. |
| F-6 | Low | attestations | Tier entries paid by the contract were never removed after a full unstake. | The entry is removed when the tier is none and the stake is zero. |
| F-7 | Low | verdicts | The model named in a NEAR AI signed text was not compared with the verdict's model. | The two must match. |

## Verified properties (summary)

- Every callback is `#[private]`; every contract is initialized with `#[init]` and `PanicOnDefault`.
- State is written before promises and restored in callbacks on failure (schema registration, the resolver gate, withdrawals, reward payouts, unstaking).
- Callbacks that must keep state never panic after changing it; promise results are read with size limits, so a malformed answer reads as a refusal.
- Only an account itself withdraws or unregisters its NEP-145 balance; every path that spends someone else's balance is authorized by them (a delegate grant, a NEP-413 signature, or their own multisig proposal).
- NEP-413: domain tag, this contract as recipient, a registered signer key (or the key an implicit account is made of), a one-time nonce charged to the attester, and a deadline.
- Multisig: 2 to 10 distinct members, no double approval, single execution, and identities only the contract can act as.
- Verdicts: allowlisted enclave keys, NEAR AI signatures over the exact signed text with the request hash bound to the evidence hash, single-use request ids, a 15 minute age limit; MPC answers checked against a payload hash the contract recomputes, with `ecrecover`'s malleability check on; wallet-link messages name the NEAR account, the wallet, this contract and a nonce.
- Release builds have `overflow-checks = true`; every loop is bounded; storage keys come from `BorshStorageKey` enums with length-prefixed tuple keys.

## Design decisions

- **Schema UIDs are computed from the definition alone**, so anyone can derive them before registering; the first registrant administers the schema's resolver settings, so important schemas are registered early.
- **Fee changes apply from the next resolver call**, so prepaid fee balances are kept small; a maximum-fee field on the attester's side is on the roadmap.
- **Reward payouts attach 0.00125 NEAR** of token storage from the resolver, and griefing that deposit costs an attacker more than it costs the resolver.
- **Contract-paid bookkeeping** (schema order list, multisig approvals, resolver admins, fee holds and tallies, staking entries) costs its trigger at least as much as the contract; contract balances are watched by the top-up service and the status page.
- **Tier pushes and credential burns are sent once**: tiers only feed views, and a credential always defers to its attestation, which reads as revoked.
- **The verdicts contract's keys** (the checker's enclave key, the NEAR AI model keys and the MPC key) are set by its owner, a role meant for a multisig on mainnet.
  See the trust model in [README.md](README.md#trust-and-privacy-model).
- **Agent function-call keys** can attest and revoke as the account that granted them, within their gas allowance, until revoked; they cannot attach deposits, move NEAR or change delegates, keys or authority settings, and `revokeAgentKey` refuses to delete any other kind of key.
- **DAO attesters** issue only through their own Sputnik policy: a passed `FunctionCall` proposal makes the DAO account call `attest`, so no single member can issue in its name.
  On the deployment DAO the keeper is a reviewer whose role can only vote on function calls, so its key alone cannot change the policy, the council or the DAO's funds (checked on testnet: its vote on a transfer fails with `ERR_PERMISSION_DENIED`).
  The keeper votes only on membership requests about the proposer, naming the DAO, in an automatic role, with no deposit; every other proposal waits for the council.
  The DAO pays for what it issues from its own NEP-145 balance on the attestations contract, which the keeper tops up in small steps.
- **Solana facts** are inner instructions read by the MPC network at `finalized` commitment; the contract checks the MPC signature over the payload it recomputes and attests the instruction exactly as the program recorded it, leaving its meaning (for example the amount of a token transfer) to the schema's reader.

## Reporting a vulnerability

Please report privately through the repository's security advisory form rather than a public issue.
Include the contract, the method and a reproduction if you have one.

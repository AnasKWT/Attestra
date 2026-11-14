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
| F-8 | High | checker, agent | A private check's subject was chosen by the caller, so one person's evidence could mark any account, and a GitHub rule accepted any login. | The subject signs the request (NEP-413) and the checker verifies the signature and the key's owner in the TEE; a GitHub login must name the subject in a public gist. |
| F-9 | High | verdicts | A foreign fact's subject was chosen by the caller and each event was single-use, so anyone could claim another person's payment first and block them. | Any subject other than the emitter must be the caller or a wallet linked to it, and events are single-use per subject. |
| F-10 | High | DAO setup | The keeper had a Sputnik role that could approve any function call, including one spending the DAO's NEAR. | The role is gone; the keeper issues through an Attestra delegate grant scoped to one schema, a use limit and an expiry. |
| F-11 | Medium | verdicts | Relinking a wallet left the previous link's attestation active, and a failed attestation left the link in place. | The replaced attestation is revoked and a failed link is rolled back with a refund. |
| F-12 | Low | credentials, attestations | Credentials outlived their attestation's expiry. | Expired credentials leave every view, anyone can burn them, and recording the expiry burns them. |
| F-13 | Low | attestations | `pending_operation_count` returned every operation ever gated. | It counts the open ones; `gated_operation_count` keeps the total. |

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
- **Agent reputation** (`packages/sdk/src/reputation.ts`): a review found that any account could attest an agent's identity and review it, owner included, so trust was free to mint.
  An identity now counts only when its `owner` is its attester and that attester is the agent account or an account the agent is a sub-account of; a review counts once per reviewer and never from the agent, its owner, their sub-accounts or an account above the agent.
  A review is paid only when its `job_ref` is a transaction read with the `tx` RPC method in which the reviewer paid the agent (or its verified owner) in NEAR or the deployment's payment token; the token's own NEP-141 events give the net amount, so a refunded `ft_transfer_call` or a look-alike token pays nothing.
  `trusted` needs a verified identity and paid reviews averaging at least 3.5, and the SDK recomputes it over RPC instead of taking the indexer's word.
  What remains: a payment of any size counts, so an owner who funds strangers' accounts to pay the agent can still buy reviews at the cost of those payments and accounts.
- **DAO attesters** issue only through their own Sputnik policy: a passed `FunctionCall` proposal makes the DAO account call `attest`, so no single member can issue in its name.
  The keeper never holds a Sputnik role, because a role that may approve function calls can approve any call, including one that spends the DAO's NEAR (F-10).
  Instead the keeper holds no role in the DAO: the council votes it an Attestra delegate grant limited on chain to the membership schema, a use limit and an expiry, and it issues with `attest_on_behalf`.
  A stolen keeper key can therefore issue at most the remaining memberships until the council withdraws the grant, and can never vote, spend or change the DAO.
  The keeper admits an account only on its own NEP-413 request (a full-access key of that account), once, and only when another issuer already vouches for it.
- **Private checks are about the account that asks.** The subject's key signs the request (NEP-413: rule, subject, SHA-256 of the exact encrypted evidence, GitHub login, a deadline under a day), and the checker in OutLayer's TEE verifies the signature and reads from NEAR RPC (fixed URLs in the build) that the key is a full-access key of the subject, or the key an implicit account is made of, before it signs a verdict.
  A GitHub rule also needs a public gist from that login naming the subject.
  The agent checks the same before it spends anything, so an unsigned request costs nothing.
- **TEE attestation and the contract.** NEAR has no host function to verify an Intel TDX or NVIDIA quote inside a contract, so the attestation is checked before a key is trusted rather than inside every call: the checker's key is derived in the TEE from the hash of its build, `pnpm verify` checks OutLayer's TDX attestation of the run that produced it, and `tools/nearai-verify` checks the model's attestation against Intel's and NVIDIA's roots.
  The contract then accepts a verdict only under those keys.
- **Foreign facts are bound to who claims them.** The default subject is the emitting contract or program; any other subject must be the caller or a wallet linked to the caller, and each event is single-use per subject, so a caller can neither claim another person's payment nor block them from claiming it.
- **Wallet links stay one-to-one.** Relinking a wallet revokes the attestation of the link it replaces, and a link whose attestation fails is rolled back with the deposit refunded.
- **Credentials end with their attestation.** A credential past its attestation's expiry disappears from every view at once and anyone can burn it; recording the expiry burns it, and the holder can always burn a credential they do not want.
- **Solana facts** are inner instructions read by the MPC network at `finalized` commitment; the contract checks the MPC signature over the payload it recomputes and attests the instruction exactly as the program recorded it, leaving its meaning (for example the amount of a token transfer) to the schema's reader.
- **Public endpoints that cost money or load are rate limited** (`packages/sdk/src/ratelimit.ts`: token buckets per client address or account, daily budgets per route, in memory with a sweep and an LRU bound).
  A refusal is a 429 with `Retry-After` and `RateLimit-*` headers; `/live` and `/health` are never limited.
  The agent limits `/v1/check` per address in front of the signature check, then per subject and per day once the signature verified, so nobody can use up another account's checks; chat and A2A share a per-address limit and a daily budget, and the 402 challenge, settlement attempts, job polls and MCP have their own.
  The relayer limits every request and, more tightly, the sponsorships that send NEAR, and sponsors an account once, ever; the keeper counts a membership per account only when it issues one.
  The client address is the first `X-Forwarded-For` hop only with `TRUST_PROXY` (on in `compose.yaml`, where Caddy replaces the header); the hosted `/mcp` route keeps its buckets per Vercel instance, and a restart resets the in-memory limits (the relayer's daily budgets and sponsorships persist).
  Clients wait out a `Retry-After` of up to 30 seconds and otherwise get the 429 at once with the server's explanation.

## Reporting a vulnerability

Please report privately through the repository's security advisory form rather than a public issue.
Include the contract, the method and a reproduction if you have one.

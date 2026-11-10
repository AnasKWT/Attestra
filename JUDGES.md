# For judges

This page maps each judging criterion to the evidence: the code (with line links), the tests and a live testnet transaction.
Every contract is deployed on testnet under `attestra.testnet` from a reproducible build; the README's "Live on testnet" table links a transaction for each flow.

## Five-minute check

```bash
pnpm install && pnpm build
pnpm test                 # every TypeScript suite (SDK, CLI, MCP, indexer, agent, services, site)
pnpm test:contracts       # every contract unit and property test
pnpm e2e                  # Playwright on a production build of the site
```

The longer checks:

```bash
contracts/scripts/build.sh && pnpm test:sandbox    # near-workspaces flows on a local node (a few minutes)
pnpm security                                      # Clippy -D warnings, cargo audit, cargo deny, pnpm audit
contracts/scripts/build.sh --reproducible          # the wasm SourceScan builds, in its pinned image
pnpm deploy:sandbox                                # the full deploy and wiring on a local node
pnpm build && pnpm cli:e2e                         # every chain-only CLI group against a fresh local deployment
pnpm test:checker                                  # the OutLayer checker, natively against a mocked host
```

Against the testnet deployment, with the stack running (`pnpm dev`):

```bash
pnpm verify               # the deployment's code, schemas, proofs, verdicts, agents, indexer, MCP tools and services, PASS or FAIL
pnpm cli:e2e testnet      # every CLI group on testnet, including the indexer, agent, NEAR AI and x402 ones (needs a funded root key)
pnpm --filter @attestra/web e2e:live   # the sandbox tools in a real browser with a passkey account, on testnet
```

## By criterion

### Technical implementation

- The resolver gate is NEAR's asynchronous model done properly: an attestation is pending while one cross-contract call asks the resolver, and the callback commits it or removes it and refunds the storage ([gate.rs#L100](contracts/attestations/src/gate.rs#L100)).
- The verdicts contract checks two signatures before it attests an AI verdict, the checker's and NEAR AI's, with `env::ed25519_verify` ([ai.rs#L84](contracts/verdicts/src/ai.rs#L84)).
- Cross-chain facts call the NEAR MPC network's `verify_foreign_transaction`, recompute the payload hash and check the answer with `env::ecrecover` ([foreign.rs#L70](contracts/verdicts/src/foreign.rs#L70), [solana.rs#L83](contracts/verdicts/src/solana.rs#L83), [mpc.rs#L272](contracts/verdicts/src/mpc.rs#L272)); the payload layouts match the MPC network's own test vectors.
- Light client proofs are checked in your own process: block approvals over 2/3 of stake and the outcome's merkle path ([lightclient.ts#L180](packages/sdk/src/lightclient.ts#L180)).
- Tests: contract unit and property tests in every crate, near-workspaces sandbox flows across all seven contracts, TypeScript suites for every package and app, Playwright on a production build and live on testnet, and a CLI end-to-end run on a local node and on testnet.
- Reviews and fixes: [SECURITY.md](SECURITY.md), with seven audit findings, a gas bug the sandbox flows found, and the accepted risks.

### Design

- The site is one design system from the landing page to the explorer and the sandbox tools, light and dark, checked at phone, tablet and desktop widths ([globals.css](apps/web/src/app/globals.css)).
- Every sandbox tool shows the transaction it sent and links it to NearBlocks; failures read as plain sentences, not raw RPC errors ([ToolFrame.tsx](apps/web/src/components/sandbox/ToolFrame.tsx)).
- Private checks show the verdict next to a link to the NEAR AI verification centre, and agent chat answers show the signature that backs them.

### Impact

- Apps and agents ask the same questions again and again: is this person over 18, does this wallet belong to them, did that payment happen, can this agent be trusted.
  Attestra lets a fact be checked once and read by any contract, app or agent.
- Issuers attest without holding NEAR through the relayer ([relayer/app.ts#L85](services/src/relayer/app.ts#L85)), and a person with no wallet signs in with a passkey ([passkey.ts#L37](apps/web/src/lib/passkey.ts#L37)).
- Agents get the whole toolset from one MCP line, hosted at `/mcp` on the site or run locally.

### Originality

- Private facts checked by a verifiable model with end-to-end encryption, where the chain stores only the verdict and the evidence hash ([check.ts#L70](apps/agent/src/check.ts#L70), [checker/src/check.rs#L228](checker/src/check.rs#L228)).
- Facts about EVM chains and Solana with no oracle, through Chain Signatures' foreign-transaction verification.
- Know Your Agent: identity, reviews, scoped delegation and a function-call access key limited to attest and revoke ([agent-keys.ts#L11](packages/sdk/src/agent-keys.ts#L11)), sold per call over x402 ([paid.ts#L30](apps/agent/src/paid.ts#L30)).

### Sustainability

- The x402 endpoints charge per verification, settled on chain before the answer; the treasury and top-up service keep the relayer, keeper and agent funded within a daily cap.
- Mainnet is one switch away, rehearsed on a local node with the mainnet code paths: [MAINNET.md](MAINNET.md).
- Contracts are reproducible builds with NEP-330 metadata ([build.sh](contracts/scripts/build.sh)), so anyone can match the deployed code to the source.

### Completeness

- Seven contracts, an SDK, a CLI and an MCP server with every NEAR-only feature, an indexer, an agent, a relayer, a keeper, a top-up service, an OutLayer checker and the site.
- `pnpm verify` ([verify.ts#L91](scripts/verify.ts#L91)) proves each README claim against the live deployment and prints PASS or FAIL per claim.
- What is not finished is listed at the end of this page.

## Claims

| Claim | Code | Tests | Live check |
|---|---|---|---|
| Schemas, attestations and revocation with deterministic UIDs | [schemas](contracts/schemas/src/lib.rs), [ops.rs](contracts/attestations/src/ops.rs), [uid.rs](contracts/common/src/uid.rs) | unit and property tests; UID vectors shared with [uid.test.ts](packages/sdk/test/uid.test.ts); sandbox `attest` and `schemas` flows | `pnpm verify` (well-known schemas); the explorer on the site |
| Resolvers gate an attestation asynchronously and roll back on refusal | [gate.rs#L100](contracts/attestations/src/gate.rs#L100), [resolvers](contracts/resolvers/src/lib.rs) | resolver unit tests; sandbox flows incl. a refusal and pipelines with rewards | the sandbox resolver tools |
| Delegation by grant and by NEP-413 signature, gasless through a relayer | [authority.rs](contracts/attestations/src/authority.rs), [ops.rs#L173](contracts/attestations/src/ops.rs#L173), [relayer](services/src/relayer/app.ts) | unit tests incl. replay and expiry; relayer tests | the live browser run issues gaslessly from a passkey account |
| Multisig authorities, scheduled revocation, credentials burned on revoke, staking tiers, large schemas | [multisig.rs#L143](contracts/attestations/src/multisig.rs#L143), [credentials](contracts/credentials/src/lib.rs#L161), [staking](contracts/staking/src/lib.rs) | unit tests; sandbox flows incl. a mint and revoke race | `pnpm cli:e2e testnet` |
| Private facts checked by verifiable AI; evidence never on chain | [ai.rs#L84](contracts/verdicts/src/ai.rs#L84), [checker](checker/src/check.rs#L228), [check.ts#L70](apps/agent/src/check.ts#L70), [e2ee.ts](packages/sdk/src/e2ee.ts) | verdicts unit tests (signatures, age, replay, model match); checker tests with vectors from the TypeScript side; agent tests with real E2EE and signatures | `pnpm verify` checks an AI-checked attestation's two signatures |
| Facts about other chains with no oracle (EVM logs and Solana instructions) | [foreign.rs#L70](contracts/verdicts/src/foreign.rs#L70), [solana.rs#L83](contracts/verdicts/src/solana.rs#L83), [mpc.rs](contracts/verdicts/src/mpc.rs) | unit and property tests against the MPC's Borsh layout and its own vectors; sandbox flows with an MPC double signing real secp256k1 answers | `pnpm verify` checks a cross-chain attestation and its final event |
| Wallet links for Ethereum and Solana wallets | [wallet.rs#L83](contracts/verdicts/src/wallet.rs#L83) | unit tests (EIP-191 recovery, ed25519); sandbox flows | `pnpm cli:e2e testnet` |
| Know Your Agent: identity, delegation, function-call keys, reviews | [schemas.ts](packages/sdk/src/schemas.ts), [agent-keys.ts#L11](packages/sdk/src/agent-keys.ts#L11), `getAgentProfile` in [client.ts](packages/sdk/src/client.ts) | SDK, CLI and MCP tests | `pnpm verify` reads an agent's reputation; `/agents` on the site |
| Light client proofs checked locally | [lightclient.ts#L180](packages/sdk/src/lightclient.ts#L180) | a recorded testnet proof in [light-client.json](packages/sdk/test/fixtures/light-client.json) | `pnpm verify` proves a recent attestation final |
| x402 paid verification on NEAR | [x402.ts#L129](packages/sdk/src/x402.ts#L129), [paid.ts#L30](apps/agent/src/paid.ts#L30) | SDK and agent tests (402, signed delegate action, settle, serve) | `pnpm cli:e2e testnet` pays for a claim and an agent check |
| MCP for any agent, hosted and local | [packages/mcp](packages/mcp/src/server.ts), [caps.ts#L13](packages/mcp/src/caps.ts#L13) | MCP tests drive every tool, the caps and the spend limits | `pnpm verify` calls every hosted tool with live data |
| Reproducible, verifiable contracts | [build.sh](contracts/scripts/build.sh), NEP-330 metadata | `pnpm verify` compares the deployed hashes with the record and a local reproducible build | `near contract verify deployed-at <account> network-config testnet now` once the repository is public |
| Mainnet-ready behind one switch | [config.ts](packages/sdk/src/config.ts), [deploy.ts](scripts/deploy.ts) (refuses mainnet without the owner's go-ahead) | the mainnet-shaped `pnpm deploy:sandbox` rehearsal | [MAINNET.md](MAINNET.md) |

## Where to read first

1. [README.md](README.md): what it is, how it works, the trust model.
2. [gate.rs](contracts/attestations/src/gate.rs): the pending, call, commit or roll back pattern every resolver goes through.
3. [ai.rs](contracts/verdicts/src/ai.rs), [foreign.rs](contracts/verdicts/src/foreign.rs) and [solana.rs](contracts/verdicts/src/solana.rs): what the contract checks before it attests a private or cross-chain fact.
4. [SECURITY.md](SECURITY.md): the audit, its findings, the fixes and the risks accepted by design.
5. [AGENTS.md](AGENTS.md): layout, commands and where each NEAR primitive lives.

## What is not finished

Stated plainly so nothing here is a surprise:

- The OutLayer checker has not run on an OutLayer worker yet; the agent runs the same checks in local mode with an allowlisted key, and the site says which mode is live.
- The contracts are verified on NearBlocks (SourceScan) only after the repository is public; until then they are reproducible builds, verifiable with `near contract verify`.
- Signing in with a NEAR wallet in a browser was tested against a mocked wallet list, not with a real wallet extension; passkey sign-in is tested live.
- Nothing is deployed on mainnet; the plan and its one switch are in [MAINNET.md](MAINNET.md).
- The npm packages are not published yet; every command above runs from the repository.

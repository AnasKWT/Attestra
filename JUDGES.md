# For judges

This page maps every claim Attestra makes to the code that implements it, the test that exercises it and the way to check it on a live deployment.
Every contract is deployed on testnet under `attestra.testnet` from a reproducible build, and the README's "Live on testnet" table links a transaction for each flow.
The local runs below exercise the same features on a local NEAR node, and the site, agent and services are tested against mocks of what they call.

## Five-minute check

```bash
pnpm install && pnpm build
pnpm test                 # every TypeScript suite (SDK, CLI, MCP, indexer, agent, services, site)
pnpm test:contracts       # 308 contract unit tests
pnpm e2e                  # 219 Playwright tests on a production build of the site
```

The longer checks:

```bash
contracts/scripts/build.sh && pnpm test:sandbox    # 19 near-workspaces flows on a local node (a few minutes)
pnpm security                                      # Clippy -D warnings, cargo audit, cargo deny, pnpm audit
contracts/scripts/build.sh --reproducible          # the wasm SourceScan builds, in its pinned image
pnpm deploy:sandbox                                # the full deploy and wiring on a local node
pnpm build && pnpm cli:e2e                         # 90 CLI steps against a fresh local deployment
pnpm cli:e2e testnet                               # the same 90 steps against the testnet deployment (needs a funded root key)
pnpm --filter @attestra/web e2e:live               # a passkey account issues a gasless attestation in a real browser, on testnet
pnpm test:checker                                  # the OutLayer checker, natively against a mocked host
```

Against the testnet deployment, with the stack running (`pnpm dev`):

```bash
pnpm verify               # the deployment's code, schemas, proofs, verdicts, agents, indexer, MCP tools and services, PASS or FAIL
```

On testnet today it passes every check except the AI-checked attestation, which waits on a NEAR AI Cloud key.

## Claims

| Claim | Code | Tests | Live check |
|---|---|---|---|
| Schemas, attestations and revocation with deterministic UIDs | `contracts/schemas`, `contracts/attestations/src/ops.rs`, `contracts/common/src/uid.rs` | unit tests in each crate; UID vectors shared with `packages/sdk/test/uid.test.ts`; sandbox `attest` and `schemas` flows | `pnpm verify` (well-known schemas); explorer on the site |
| Resolvers gate an attestation asynchronously and roll back on refusal | `contracts/attestations/src/gate.rs`, `contracts/resolvers` | resolver unit tests; sandbox `resolvers` flows incl. a refusal and pipelines with rewards | sandbox tools on the site (whitelist, fee, token gate, reward, pipeline) |
| Delegation by grant and by NEP-413 signature, gasless through a relayer | `contracts/attestations/src/authority.rs`, `ops.rs` (`submit_signed`), `services/src/relayer` | unit tests incl. replay and expiry; relayer tests | sandbox "Delegated attestation" and "Gasless issuing" |
| Multisig authorities, scheduled revocation, credentials burned on revoke, staking tiers, large schemas | `contracts/attestations/src/multisig.rs`, `contracts/credentials`, `contracts/staking`, `contracts/schemas` | unit tests; sandbox flows incl. a mint and revoke race | sandbox tools of the same names |
| Private facts checked by verifiable AI; evidence never on chain | `contracts/verdicts/src/ai.rs`, `checker/` (OutLayer TEE, build-bound key), `apps/agent/src/{check,outlayer}.ts`, `packages/sdk/src/e2ee.ts` | verdicts unit tests (signatures, age, replay, model match); checker tests with vectors from the TypeScript side; agent tests with real E2EE and signatures | `pnpm verify` checks an AI-checked attestation's two signatures |
| Facts about other chains with no oracle | `contracts/verdicts/src/{foreign,mpc}.rs` | unit tests against the MPC's Borsh layout; sandbox flows with an MPC double signing real secp256k1 answers | `pnpm verify` checks a cross-chain attestation and its final event |
| Wallet links for Ethereum and Solana wallets | `contracts/verdicts/src/wallet.rs` | unit tests (EIP-191 recovery, ed25519); sandbox `verdicts` flows | sandbox "Wallet link" |
| Know Your Agent: identity, delegation, reviews | well-known schemas in `packages/sdk/src/schemas.ts`, `getAgentProfile` in `client.ts` | SDK and MCP tests | `pnpm verify` reads an agent's reputation; `/agents` on the site |
| Light client proofs checked locally | `packages/sdk/src/lightclient.ts` | a recorded testnet proof in `packages/sdk/test/fixtures/light-client.json` | `pnpm verify` proves a recent attestation final |
| x402 paid verification on NEAR | `packages/sdk/src/x402.ts`, `apps/agent/src/paid.ts` | SDK and agent tests (402, signed delegate action, settle, serve) | sandbox "Paid verification" |
| MCP for any agent, hosted and local | `packages/mcp`, `apps/web/src/app/mcp` | MCP tests drive every read tool and the caps | `/mcp` on the site; `claude mcp add` in [SKILL.md](skills/attestra/SKILL.md) |
| Reproducible, verifiable contracts | `contracts/scripts/build.sh`, NEP-330 metadata | `pnpm verify` compares the deployed hashes with the record and a local reproducible build | `near contract verify deployed-at <account> network-config testnet now`; `pnpm verify` |
| Mainnet-ready behind one switch | `packages/sdk/src/config.ts`, `scripts/deploy.ts` (refuses mainnet without the owner's go-ahead) | `pnpm deploy:sandbox` rehearsal | [MAINNET.md](MAINNET.md) |

## Where to read first

1. [README.md](README.md): what it is, how it works, the trust model.
2. `contracts/attestations/src/gate.rs`: the pending, call, commit or roll back pattern every resolver goes through.
3. `contracts/verdicts/src/ai.rs` and `foreign.rs`: what the contract checks before it attests a private or cross-chain fact.
4. [SECURITY.md](SECURITY.md): the audit, its seven findings, a gas bug the sandbox flows found, the fixes, and the risks accepted by design.
5. [AGENTS.md](AGENTS.md): layout, commands and where each NEAR primitive lives.

## What is not finished

Stated plainly so nothing here is a surprise:

- No AI-checked attestation is on testnet yet: the private check needs a NEAR AI Cloud key, so its flow is proven by the agent and verdicts tests and the sandbox flows.
- The OutLayer checker has not yet run on an OutLayer worker or against live NEAR AI; its tests use mocked hosts and vectors from the TypeScript side.
- Nothing is deployed on mainnet; the plan and its one switch are in [MAINNET.md](MAINNET.md).
- The npm packages are not published yet; every command above runs from the repository.

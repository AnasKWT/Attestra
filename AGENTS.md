# Working on Attestra

Attestra is the trust layer for NEAR: a schema-based attestation protocol for issuing, managing and verifying claims about people, wallets on any chain, and AI agents.
This file is for AI agents and engineers working in the repository; the product overview is in [README.md](README.md) and the judging map in [JUDGES.md](JUDGES.md).

## Layout

- `contracts/` (Rust, near-sdk 5.30, one Cargo workspace, reproducible builds with NEP-330 metadata):
  - `common`: UIDs, NEP-297 events, the resolver interface, NEP-413 hashing, NEP-145 storage ledger, schema definitions.
  - `schemas`: schema registry, large definitions as blobs, resolver validation.
  - `attestations`: attestations, the resolver gate (pending, commit, rollback), authorities, delegates, NEP-413 signed requests, multisig authorities, scheduled revocation, expiry events.
  - `resolvers`: one wasm deployed five times: whitelist, fee, token gated, token reward, pipeline.
  - `credentials` (NEP-171, non-transferable, burned on revoke), `staking` (NEP-141 tiers), `token` (testnet NEP-141 with a faucet).
  - `verdicts`: AI-checked facts (enclave and NEAR AI signatures), cross-chain facts (Chain Signatures `verify_foreign_transaction`), wallet links (EIP-191, ed25519).
  - `sandbox-tests`: near-workspaces flows across all contracts.
- `checker/` (Rust, its own Cargo project, wasm32-wasip2): the private checker as a NEAR OutLayer component; signs verdicts with an OutLayer signing key bound to its build (`bind: "wasm"`), started on chain by the agent when `CHECKER_MODE=outlayer`.
- `packages/sdk` (`@attestra/sdk`): `AttestraClient` on near-kit, `SchemaEncoder` (Borsh), UIDs, NEP-413, light client proofs, x402, E2EE, agent tools; `@attestra/sdk/ai` for LangChain.
- `packages/cli` (`@attestra/cli`, binary `attestra`), `packages/mcp` (`@attestra/mcp`, binary `attestra-mcp`).
- `apps/web`: Next.js 16 site, explorer, sandbox (31 tools), docs, `/mcp` (hosted, read only), `/llms.txt`.
- `apps/indexer`: FastNEAR transactions API to Postgres, REST API on port 5100.
- `apps/agent`: NEAR AI Cloud agent (chat, private checks, x402 paid verification, A2A, MCP) on port 5300.
- `services/`: relayer (5200), keeper (5400), top-up (5500).
- `scripts/`: `deploy.ts` (testnet, mainnet guarded, local sandbox rehearsal), `verify.ts`, `security.ts`, `dev.ts`.
- `deployments/<network>.json`: deployed accounts, code hashes, transactions, commit.
- `skills/attestra/SKILL.md`: the agent skill for using and extending Attestra.

## Commands

```bash
pnpm install && pnpm build          # SDK, MCP and CLI to dist/
pnpm test                           # every TypeScript suite
pnpm test:contracts                 # every contract unit test
pnpm test:checker                   # the OutLayer checker (cargo test in checker/, native, mocked host)
checker/build.sh --reproducible     # checker wasm in OutLayer's pinned compiler image, prints its sha256
pnpm test:sandbox                   # near-workspaces flows (build wasm first: contracts/scripts/build.sh)
pnpm typecheck && pnpm lint
pnpm security                       # Clippy -D warnings, cargo audit, cargo deny, pnpm audit
pnpm dev                            # indexer, agent, services and the site against testnet
docker compose up --build           # the same stack in containers (site with --profile site)
pnpm verify                         # a live deployment and its stack (code hashes, proofs, verdicts, services), PASS or FAIL
pnpm e2e                            # Playwright on a production build of the site, no deployment needed (E2E_PORT, default 3100)
contracts/scripts/build.sh --reproducible   # wasm from a commit in SourceScan's pinned image
pnpm deploy:sandbox                 # full deploy rehearsal on a local node
REHEARSE=mainnet BUILD=<commit> pnpm deploy:sandbox   # the mainnet code paths on a local node
pnpm cli:e2e                        # every chain-only CLI group against a fresh local deployment (build first)
pnpm cli:e2e testnet                # the same against the testnet deployment, signed by its root; costs about 0.4 NEAR
pnpm accounts testnet               # treasury, relayer, keeper and agent accounts; env lines to the gitignored internal/secrets/
```

- Indexer tests use `TEST_DATABASE_URL` (default `postgres://localhost:5432/attestra_test`); under `CI` without it they are skipped.
- Services and the agent run read-only without keys and say what is off on `/health`.

## Where each NEAR primitive lives

| Primitive | Code |
|---|---|
| NEP-297 events | `contracts/common/src/events.rs`, parsed in `apps/indexer/src/events.ts` |
| NEP-145 storage | `contracts/common/src/storage.rs` |
| NEP-413 signed requests | `contracts/common/src/nep413.rs`, `contracts/attestations/src/ops.rs` (`submit_signed`), `packages/sdk/src/nep413.ts` |
| NEP-366 meta transactions | `services/src/relayer/meta.ts`, x402 settlement in `apps/agent/src/paid.ts` |
| NEP-171 credentials | `contracts/credentials` |
| NEP-141 fees, gates, rewards, staking | `contracts/resolvers/src/{fee,gate,reward}.rs`, `contracts/staking` |
| Cross-contract resolver gate | `contracts/attestations/src/gate.rs`, `contracts/resolvers/src/pipeline.rs` |
| Light client proofs | `packages/sdk/src/lightclient.ts` |
| Chain Signatures foreign tx | `contracts/verdicts/src/{foreign,mpc}.rs` |
| NEAR AI Cloud (verifiable models, E2EE, signatures) | `apps/agent/src/{nearai,check,chat}.ts`, `packages/sdk/src/e2ee.ts`, `contracts/verdicts/src/ai.rs`, `checker/src/{e2ee,nearai,check}.rs` |
| OutLayer TEE (build-bound signing key, `request_execution`) | `checker/`, `apps/agent/src/outlayer.ts` |
| Wallets: NEAR Connect and passkeys | `apps/web/src/components/wallet/WalletProvider.tsx`, `apps/web/src/lib/passkey.ts` |
| Gas keys (relayer lanes) | `services/src/lib/chain.ts`, `services/scripts/setup-gas-key.ts` |
| x402 on NEAR | `packages/sdk/src/x402.ts`, `apps/agent/src/paid.ts` |

## How to verify each claim

Run `pnpm verify`; each check prints what it proved.
By hand: `near contract verify deployed-at attestations.attestra.testnet network-config testnet now` rebuilds a contract from the commit its NEP-330 metadata names and compares it with the deployed code.

## Conventions

- One network switch: `NEAR_NETWORK` (services, CLI, MCP), `NEXT_PUBLIC_NEAR_NETWORK` (site). Contract ids derive from the deployment root (`attestra.testnet`).
- UIDs are 64 lowercase hex characters; `packages/sdk/src/uid.ts` and `contracts/common/src/uid.rs` share test vectors.
- Every SDK method returns `ServiceResponse<T>` and never throws. Every CLI command takes `--json`.
- Times are unix seconds. Amounts are strings in the token's smallest unit.
- Secrets only in gitignored `.env` files; every app and service that reads settings ships a `.env.example`.
- Prose: no em dash; one sentence per line in long Markdown.

## Traps

- A resolver call is asynchronous: an attestation under a schema with a resolver is `pending` until the callback; a refusal removes it (status `rejected` in the outcome).
- Callbacks must never panic after state they need to keep was changed; use the helpers in `common` to read promise results.
- The FastNEAR transactions API allows about 60 requests a minute without a key; the indexer paces itself.
- RPC views at `final` lag a just-sent transaction by a block or two; the SDK reads `optimistic`.
- NEAR keys are base58 and case-sensitive: never lowercase a key.
- The checker's key changes with every build: a new `checker/` wasm needs `set_enclave_keys` on the verdicts contract and a new `OUTLAYER_WASM_HASH`; regenerate `checker/tests/fixtures/ts.json` after changing the E2EE, prompt or digest code on either side.
- `next lint` is gone in Next.js 16: lint the site with `pnpm --filter @attestra/web lint`.

# Attestra for AI agents

Attestra is the trust layer for NEAR: a schema-based attestation protocol for issuing, managing and verifying claims about people, wallets on any chain, and AI agents.
This file is the map for AI agents and engineers reading or extending the repository.
The product overview is [README.md](README.md); each judging criterion is mapped to code and transactions in [JUDGES.md](JUDGES.md).

## Live endpoints

| What | Where |
|---|---|
| Site, explorer and sandbox | https://attestra.site |
| Machine-readable overview | https://attestra.site/llms.txt |
| MCP server (streamable HTTP, read tools) | https://attestra.site/mcp |
| Service health | https://attestra.site/status |
| Indexer REST API | https://api.attestra.site/indexer (`/api/stats`, `/api/schemas`, `/api/attestations`, `/api/events`) |
| Agent (chat, private checks, x402, A2A) | https://api.attestra.site/agent, card at https://api.attestra.site/.well-known/agent-card.json |
| Contracts | NEAR testnet under `attestra.testnet`, listed in [deployments/testnet.json](deployments/testnet.json); mainnet-ready, see [MAINNET.md](MAINNET.md) |

Connect an agent in one line: `claude mcp add --transport http attestra https://attestra.site/mcp`.
The skill in [skills/attestra/SKILL.md](skills/attestra/SKILL.md) teaches the protocol, the schemas and the tools.

## Reading order

1. [README.md](README.md): what Attestra does, how a claim becomes trusted, and every flow with its transaction.
2. `contracts/attestations/src/gate.rs` and `ops.rs`: the core write path, including the asynchronous resolver gate.
3. `contracts/verdicts/src/`: the authority for facts nobody can simply assert (`ai.rs`, `foreign.rs`, `solana.rs`, `mpc.rs`, `wallet.rs`).
4. `packages/sdk/src/client.ts`: every operation as one typed client; `lightclient.ts` for finality proofs.
5. `apps/agent/src/`: the NEAR AI agent, private checks (`check.ts`, `outlayer.ts`), x402 (`paid.ts`) and A2A (`a2a.ts`).
6. [SECURITY.md](SECURITY.md) for the security review and [MAINNET.md](MAINNET.md) for the production configuration.

## Layout

- `contracts/` (Rust, near-sdk 5.30, one Cargo workspace, reproducible builds with NEP-330 metadata):
  - `common`: UIDs, NEP-297 events, the resolver interface, NEP-413 hashing, NEP-145 storage ledger, schema definitions.
  - `schemas`: schema registry, large definitions as blobs, resolver validation.
  - `attestations`: attestations, the resolver gate (pending, commit, rollback), authorities, delegates, NEP-413 signed requests, multisig authorities, scheduled revocation, expiry events.
  - `resolvers`: one wasm deployed five times: whitelist, fee, token gated, token reward, pipeline.
  - `credentials` (NEP-171, non-transferable, burned on revoke), `staking` (NEP-141 tiers), `token` (NEP-141 test token with a faucet).
  - `verdicts`: AI-checked facts (checker and NEAR AI signatures), facts about EVM logs and Solana instructions (Chain Signatures `verify_foreign_transaction`), wallet links (EIP-191, ed25519).
  - `sandbox-tests`: near-workspaces flows across all contracts.
- `checker/` (Rust, wasm32-wasip2): the private checker as a NEAR OutLayer component; it signs verdicts with a key derived inside the TEE from the hash of its own build.
- `packages/sdk` (`attestra`): `AttestraClient` on near-kit, `SchemaEncoder` (Borsh), UIDs, NEP-413, light client proofs, x402, end-to-end encryption, agent tools; `attestra/ai` for LangChain.
- `packages/cli` (`attestra-cli`, binary `attestra`) and `packages/mcp` (`attestra-mcp`, binary `attestra-mcp`).
- `apps/web`: Next.js 16 site, explorer, sandbox (32 tools), docs, `/mcp`, `/llms.txt`.
- `apps/indexer`: FastNEAR transactions API to Postgres, REST API on port 5100.
- `apps/agent`: NEAR AI Cloud agent (chat, private checks, x402 paid verification, A2A, MCP) on port 5300.
- `services/`: relayer (5200), keeper (5400, also a Sputnik DAO reviewer), top-up (5500).
- `tools/nearai-verify`: independent TEE attestation checks with the official `@nearai/inference-sdk`.
- `scripts/`: `deploy.ts` (testnet, mainnet, local sandbox rehearsal), `dao.ts` (the deployment's Sputnik DAO), `verify.ts`, `security.ts`, `cli-e2e.ts`, `dev.ts`, `accounts.ts`, `outlayer-publish.ts`.
- `deployments/<network>.json`: deployed accounts, code hashes, transactions and the commit they were built from.
- `compose.yaml` and `deploy/Caddyfile`: the whole stack in containers, with TLS for a public host.

## Where each NEAR primitive lives

| Primitive | Code |
|---|---|
| NEP-297 events | `contracts/common/src/events.rs`, parsed in `apps/indexer/src/events.ts` |
| NEP-145 storage | `contracts/common/src/storage.rs` |
| NEP-413 signed requests | `contracts/common/src/nep413.rs`, `contracts/attestations/src/ops.rs` (`submit_signed`), `packages/sdk/src/nep413.ts` |
| NEP-366 meta transactions | `services/src/relayer/meta.ts`, x402 settlement in `apps/agent/src/paid.ts` |
| NEP-171 credentials | `contracts/credentials` |
| NEP-141 fees, gates, rewards, staking | `contracts/resolvers/src/{fee,gate,reward}.rs`, `contracts/staking` |
| Asynchronous cross-contract resolver gate | `contracts/attestations/src/gate.rs`, `contracts/resolvers/src/pipeline.rs` |
| Light client proofs | `packages/sdk/src/lightclient.ts` |
| Chain Signatures foreign transactions (EVM logs, Solana inner instructions) | `contracts/verdicts/src/{foreign,solana,mpc}.rs`, `packages/sdk/src/verdicts.ts` |
| NEAR AI Cloud (verifiable models, end-to-end encryption, signatures) | `apps/agent/src/{nearai,check,chat}.ts`, `packages/sdk/src/e2ee.ts`, `contracts/verdicts/src/ai.rs`, `checker/src/{e2ee,nearai,check}.rs` |
| NEAR OutLayer TEE (build-bound signing key, `request_execution`) | `checker/`, `apps/agent/src/outlayer.ts` |
| Wallets: NEAR Connect and passkeys | `apps/web/src/components/wallet/WalletProvider.tsx`, `apps/web/src/lib/passkey.ts` |
| Gas keys (relayer lanes) | `services/src/lib/chain.ts`, `services/scripts/setup-gas-key.ts` |
| x402 on NEAR | `packages/sdk/src/x402.ts`, `apps/agent/src/paid.ts` |
| Sputnik DAO attesters (proposal, council vote, the DAO account attests) | `packages/sdk/src/dao.ts`, `services/src/keeper/council.ts`, `apps/web/src/app/sandbox/app/dao-attestation` |
| Function-call access keys for agents | `packages/sdk/src/agent-keys.ts` (attest and revoke only, gas allowance) |
| NEAR Agent Market | `apps/agent/src/market.ts` |

## How to verify each claim

`pnpm verify` prints PASS or FAIL for the deployed code against a reproducible build, the well-known schemas, a light client proof, an AI-checked attestation's signatures, the NEAR AI model's TEE attestation, the OutLayer checker key, a cross-chain attestation, an agent's reputation, the indexer, every hosted MCP tool and the services.
Point it at the hosted stack with `SITE_URL=https://attestra.site` and `INDEXER_URL`, `AGENT_URL`, `RELAYER_URL`, `KEEPER_URL`, `TOPUP_URL` under `https://api.attestra.site/`.
By hand, `near contract verify deployed-at attestations.attestra.testnet network-config testnet now` rebuilds a contract from the commit its NEP-330 metadata names and compares it with the deployed code.

## Commands

```bash
pnpm install && pnpm build          # SDK, MCP and CLI to dist/
pnpm test                           # every TypeScript suite
pnpm test:contracts                 # every contract unit and property test
pnpm test:checker                   # the OutLayer checker, natively against a mocked host
pnpm test:sandbox                   # near-workspaces flows (build the wasm first: contracts/scripts/build.sh)
pnpm typecheck && pnpm lint
pnpm security                       # Clippy -D warnings, cargo audit, cargo deny, pnpm audit
pnpm e2e                            # Playwright on a production build of the site (E2E_PORT, default 3100)
pnpm dev                            # indexer, agent, services and the site against testnet
docker compose up --build           # the same stack in containers (the site with --profile site, TLS with --profile tls)
pnpm verify                         # a live deployment and its stack, PASS or FAIL
pnpm cli:e2e [testnet]              # every CLI group against a fresh local deployment, or against testnet
pnpm --filter @attestra/web e2e:live   # every sandbox scenario in a real browser with a passkey account (E2E_LIVE, E2E_INDEXER, E2E_AGENT)
contracts/scripts/build.sh --reproducible   # contract wasm from a commit in SourceScan's pinned image
checker/build.sh --reproducible     # checker wasm in OutLayer's pinned compiler image
pnpm deploy:sandbox                 # the full deployment and wiring on a local node
REHEARSE=mainnet BUILD=<commit> pnpm deploy:sandbox   # the mainnet configuration on a local node
pnpm accounts testnet               # service accounts; their keys go to the gitignored .secrets/
pnpm dao setup testnet              # the deployment's Sputnik DAO (keeper and root on its council); `pnpm dao demo` runs a proposal and vote
pnpm outlayer:publish <wasm>        # publish a checker build to FastFS and record its key in deployments/
```

- `tools/nearai-verify` is its own pnpm workspace because `@nearai/inference-sdk` needs Node 24.22 or newer; `pnpm verify` runs it with Node 24.
- Indexer database tests use `TEST_DATABASE_URL` (default `postgres://localhost:5432/attestra_test`).
- Every service runs read-only without keys and reports what is enabled on `/health`.

## Conventions

- One network switch: `NEAR_NETWORK` (services, CLI, MCP) and `NEXT_PUBLIC_NEAR_NETWORK` (site); contract ids derive from the deployment root.
- UIDs are 64 lowercase hex characters; `packages/sdk/src/uid.ts` and `contracts/common/src/uid.rs` share test vectors.
- Every SDK method returns `ServiceResponse<T>` and never throws; every CLI command takes `--json`.
- Times are unix seconds; amounts are strings in the token's smallest unit.
- Secrets live only in gitignored `.env` files; every app and service that reads settings ships a `.env.example`.
- One relayer, keeper and agent per network: they sign with their own keys and own their nonces.

## Engineering notes

- A resolver call is asynchronous: an attestation under a schema with a resolver is `pending` until the callback, and a refusal removes it (status `rejected` in the outcome).
- Callbacks never panic after changing state they keep; the helpers in `common` read promise results.
- The SDK reads views at `optimistic` finality, so a just-sent transaction is visible at once.
- `AttestraClient.rpc` fails over across RPC endpoints and asks the archival endpoint for transactions, receipts and blocks older than the regular nodes keep.
- A Sputnik DAO attests through a `FunctionCall` proposal: when the council approves, the DAO account calls `attest` and pays from its NEP-145 storage balance on the attestations contract.
  On the deployment DAO the keeper is a reviewer whose role can only vote on function calls; it votes on membership requests by a fixed rule (`review` in `council.ts`) and leaves every other proposal to the council.
- Private checks run as agent jobs (`POST /v1/check` with `async: true`, then `GET /v1/check/jobs/:id`), and the agent resends a TEE run that its queue did not answer in time.
- A new `checker/` build has a new key: register it with `set_enclave_keys` on the verdicts contract and set `OUTLAYER_WASM_HASH`.
- NEAR keys are base58 and case-sensitive.
- The site lints with `pnpm --filter @attestra/web lint`; its landing page motion lives in `globals.css` (Motion section) and `components/marketing/Motion.tsx`, and every animation rests in a readable final state under `prefers-reduced-motion`.

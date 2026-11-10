<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/hero-light.png">
  <img src="assets/readme/hero-dark.png" alt="Attestra: the trust layer for NEAR" width="960">
</picture>

# Attestra

**The problem:** apps and AI agents on NEAR keep asking the same questions: is this person over 18, does this wallet on another chain belong to them, did that payment happen, can this agent be trusted with a task.
Each app answers them again, usually by collecting documents it should not hold or by trusting an oracle.
Attestra lets a fact be checked once and then read by any contract, app or agent, with a proof instead of a promise.

Attestra is the trust layer for NEAR: a schema-based attestation protocol for issuing, managing and verifying claims about people, wallets on any chain, and AI agents.
A schema defines the shape of a claim, an authority issues attestations against it, and resolvers add rules such as whitelists, fees, token gates and rewards.
Attestations can be delegated, scheduled for revocation, minted as non-transferable credentials and proven final with a light client proof.

On NEAR it goes past a registry:

- **Private facts, checked by verifiable AI.** Evidence such as an ID scan or a payslip is encrypted in the browser to a NEAR AI Cloud model; only the verdict and a hash reach the chain, and the contract checks the model's signature.
- **Facts about other chains, with no oracle.** The contract asks the NEAR MPC network to verify a transaction on Base, Arbitrum, Polygon, BNB or Avalanche (`verify_foreign_transaction`) and checks the signed answer itself.
- **Know Your Agent.** AI agents get an on-chain identity, scoped delegation and reviews, and other agents read them through MCP before they trust or pay one.

| | |
|---|---|
| Testnet contracts | `attestra.testnet`: `schemas.`, `attestations.`, `verdicts.`, `credentials.`, `staking.`, `token.` and the resolvers `whitelist.`, `fee.`, `gated.`, `reward.`, `pipeline.` (deployment pending: `pnpm deploy:testnet` writes the accounts, code hashes and transactions to `deployments/testnet.json`) |
| Demo | site and video: `[placeholder]` |
| Packages | `@attestra/sdk`, `@attestra/cli` (binary `attestra`), `@attestra/mcp` |
| For agents | [AGENTS.md](AGENTS.md), [skills/attestra/SKILL.md](skills/attestra/SKILL.md), `/llms.txt` and `/mcp` on the site |
| For judges | [JUDGES.md](JUDGES.md): every claim, where it lives and how to check it |

## How it works

<img src="assets/readme/pipeline.png" alt="How a fact becomes trusted on NEAR: an issuer, private evidence or another chain's transaction goes to the attestations or verdicts contract, which check it with resolvers, NEAR AI signatures or the MPC network, and anyone verifies the result with verify_attestation, a light client proof, a credential or an agent's reputation" width="960">

1. An issuer signs in with a NEAR wallet or a passkey and calls `attest` on the attestations contract, directly or gasless through the relayer with a NEP-413 signed request or a NEP-366 meta transaction.
2. If the schema has a resolver, the attestation is pending while one cross-contract call asks the resolver; its callback commits the attestation or removes it and refunds the storage.
3. The commit emits a NEP-297 event; the indexer, the keeper and the explorer read it, and anyone can prove the event final with a light client proof checked in their own process.
4. For facts nobody can just assert, the verdicts contract is the authority: it accepts an AI verdict only with valid checker and NEAR AI signatures, and a foreign event only with the MPC network's signature over a payload hash it recomputes.

## Only on NEAR

| Feature | NEAR primitive | Where |
|---|---|---|
| Private AI checks | NEAR AI Cloud verifiable models, end-to-end encryption, response signatures checked with `env::ed25519_verify` | `contracts/verdicts/src/ai.rs`, `apps/agent/src/check.ts` |
| Cross-chain facts | Chain Signatures `verify_foreign_transaction`, answer checked with `env::ecrecover` | `contracts/verdicts/src/{foreign,mpc}.rs` |
| Wallet links | EIP-191 and ed25519 signatures verified on chain | `contracts/verdicts/src/wallet.rs` |
| Resolver gate | asynchronous cross-contract call with commit or rollback, five resolver kinds in one wasm | `contracts/attestations/src/gate.rs`, `contracts/resolvers` |
| Gasless issuing | NEP-366 meta transactions, NEP-413 signed requests, gas key lanes in the relayer | `services/src/relayer`, `contracts/attestations/src/ops.rs` |
| Passkey accounts | WebAuthn PRF to an ed25519 implicit account | `apps/web/src/lib/passkey.ts` |
| Light client proofs | block approvals over 2/3 of stake and the outcome's merkle path, checked locally | `packages/sdk/src/lightclient.ts` |
| Paid verification | x402 on NEAR: a delegate action carrying `ft_transfer`, settled before the answer | `packages/sdk/src/x402.ts`, `apps/agent/src/paid.ts` |
| Credentials | NEP-171, non-transferable, burned when the attestation is revoked | `contracts/credentials` |
| Reproducible builds | NEP-330 metadata, `near contract verify` | `contracts/scripts/build.sh` |

## Quickstart

Requirements:
- Node 22 and pnpm 10.
- Rust through rustup; the contracts pin their toolchain in `contracts/rust-toolchain.toml` (installed on first use), and the checker needs `rustup target add wasm32-wasip2` (its published build uses OutLayer's pinned compiler image, so it carries no toolchain file).
- `cargo install cargo-near --version 0.22.0` for the contract builds; `cargo-audit` and `cargo-deny` for `pnpm security`.
- Docker for the reproducible builds; Postgres only for the indexer's database tests (see `apps/indexer/README.md`; they are skipped without it).
- Playwright's Chromium for `pnpm e2e` (`pnpm --filter @attestra/web exec playwright install chromium`).

Everything below runs on a fresh clone with no deployment and no keys:

```bash
pnpm install && pnpm build
pnpm test                 # every TypeScript suite (137 tests; 3 indexer database tests skip without Postgres)
pnpm test:contracts       # every contract unit test (308)
pnpm test:checker         # the OutLayer checker (23)
contracts/scripts/build.sh && pnpm test:sandbox   # 19 flows across every contract on a local NEAR node
pnpm cli:e2e              # 90 CLI steps against a fresh local deployment
pnpm e2e                  # 219 Playwright tests on a production build of the site
```

`pnpm dev` starts the site on :3100 with the indexer, agent and services against testnet.

Read an attestation from code:

```ts
import { AttestraClient } from '@attestra/sdk';

const client = new AttestraClient({ network: 'testnet' });
const valid = await client.isValid('<uid>');
const att = await client.getAttestation('<uid>');
if (valid.data?.valid) console.log('active', att.data);
```

Give an agent the tools (Claude Code shown; Codex and others in [SKILL.md](skills/attestra/SKILL.md)):

```bash
claude mcp add attestra -- node packages/mcp/dist/cli.js
```

From the command line, every command takes `--json`:

```bash
node packages/cli/dist/index.js attestation verify <uid> --json
```

## Verify it yourself

The local runs in the Quickstart exercise every feature: resolvers, delegation, gasless and signed requests, credentials, scheduled revocation, multisig, staking, wallet links and cross-chain facts (against an MPC double that signs real secp256k1 answers).

Against a live deployment, `pnpm verify` prints PASS or FAIL for: the test suites, the deployed code against the recorded hashes and a local reproducible build of the recorded commit (`contracts/scripts/build.sh --reproducible <commit>` first), the well-known schemas, a light client proof of a recent attestation, an AI-checked attestation's signatures, a cross-chain attestation, an agent's reputation, the indexer's lag, and the site, MCP and service health (start them with `pnpm dev`, or set `SITE_URL` and the service URLs to a hosted stack).

```bash
pnpm verify
```

By hand, for any contract:

```bash
near contract verify deployed-at attestations.attestra.testnet network-config testnet now
```

## Trust and privacy model

- **What is public:** every attestation's schema, subject, attester and data. Never put secrets or raw evidence in attestation data.
- **What stays private:** evidence for a private check is encrypted in the browser to the NEAR AI model's key; the chain stores only the verdict, the rule, the model and the evidence hash.
- **Whom you trust for an AI verdict:** the model's signing key, published by NEAR AI Cloud from inside its TEE, and the checker key that the verdicts contract's owner allowlisted. The contract checks both signatures and that the NEAR AI signature covers the exact request it was given. The model's answer travels encrypted, so the chain cannot see it: the checker verifies that the signature covers the answer, and the contract relies on the checker's signature for the result.
- **Where the checker runs:** `checker/` is a WASI component for NEAR OutLayer whose signing key is derived inside the TEE from the hash of its own build, so no one, the operators included, can make other code sign with it. The agent can also run the same steps locally with a configured key (`CHECKER_MODE=local`); the status page says which mode is live.
- **Whom you trust for a foreign event:** the NEAR MPC network's key; the contract recomputes the signed payload hash itself.
- **Whom you trust for "final":** NEAR's validators, through a light client proof you check yourself: more than 2/3 of stake approved the block, and the outcome's merkle path leads to it. The validator set itself comes from the RPC node you ask (`EXPERIMENTAL_validators_ordered`); the SDK does not yet follow the `next_bp_hash` chain from a trusted checkpoint.
- **Contract owners** can change allowlisted keys and resolver settings; reviews, fixes and accepted risks are in [SECURITY.md](SECURITY.md).

## Hackathon tracks

- **Privacy and Private AI:** private facts checked by verifiable AI with end-to-end encryption; only a verdict and a hash go on chain.
- **Agent Economy:** Know Your Agent identity, scoped delegation and reviews; MCP and A2A interfaces; x402 paid verification.
- **Social Money:** gasless issuing, passkey accounts and credentials that let communities vouch for people and gate rewards.
- **Open Innovation:** cross-chain facts with no oracle through Chain Signatures, and light client proofs any client can check.

## Repository

<img src="assets/readme/repository.png" alt="What is in the repository: Rust contracts with the resolver gate and the verdicts contract, the TypeScript SDK, CLI and MCP packages, and the web, indexer and agent apps with the relayer, keeper and top-up services and the OutLayer checker" width="960">

<img src="assets/readme/tree.png" alt="Annotated repository tree, including the OutLayer checker, with the verdicts contract's AI, foreign-transaction, MPC and wallet-link modules highlighted" width="960">

## Status

- Testnet deployment pending (the faucet rate-limited this machine); every feature runs end to end on a local NEAR node today.
- Mainnet is one switch away and not deployed: see [MAINNET.md](MAINNET.md).
- The npm packages are packed and tested from a clean install but not published; every command above runs from the repository.
- The OutLayer checker is tested against mocked hosts and vectors from the TypeScript side; it has not yet run on an OutLayer worker or live NEAR AI.

## Built with

- Contracts: Rust, near-sdk 5.30, cargo-near 0.22 (SourceScan's reproducible build image), near-workspaces for sandbox tests.
- Checker: Rust on wasm32-wasip2 for NEAR OutLayer; ed25519-dalek, x25519-dalek, chacha20poly1305, hkdf, sha2, borsh.
- TypeScript: near-kit, @noble/curves, @noble/hashes and @noble/ciphers, the MCP TypeScript SDK, commander, hono, pg; LangChain and zod as optional peers of `@attestra/sdk/ai`.
- Site: Next.js 16, React 19, Tailwind CSS 4, NEAR Connect (`@hot-labs/near-connect`), lucide-react; vitest and Playwright for tests.
- NEAR services: NEAR AI Cloud, NEAR OutLayer, Chain Signatures (MPC `verify_foreign_transaction`), FastNEAR RPC and transactions API.
- AI-generated code: the code, tests and docs were written with AI coding assistants (Claude Code) under the author's direction and review.
- No templates; the README images are drawn by `tools/make_readme_art.py` from the site's own design tokens.

## Team

`[placeholder]`

## License

[MIT](LICENSE)

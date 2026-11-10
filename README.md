<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/hero-light.png">
  <img src="assets/readme/hero-dark.png" alt="Attestra: the trust layer for NEAR" width="960">
</picture>

# Attestra

Attestra is the trust layer for NEAR: a schema-based attestation protocol for issuing, managing and verifying claims about people, wallets on any chain, and AI agents.
A schema defines the shape of a claim, an authority issues attestations against it, and resolvers add rules such as whitelists, fees, token gates and rewards.
Attestations can be delegated, scheduled for revocation, minted as non-transferable credentials and proven final with a light client proof.

On NEAR it goes past a registry:

- **Private facts, checked by verifiable AI.** Evidence such as an ID scan or a payslip is encrypted in the browser to a NEAR AI Cloud model; only the verdict and a hash reach the chain, and the contract checks the model's signature.
- **Facts about other chains, with no oracle.** The contract asks the NEAR MPC network to verify a transaction on Base, Arbitrum, Polygon, BNB or Avalanche (`verify_foreign_transaction`) and checks the signed answer itself.
- **Know Your Agent.** AI agents get an on-chain identity, scoped delegation and reviews, and other agents read them through MCP before they trust or pay one.

| | |
|---|---|
| Testnet contracts | `attestra.testnet`: `schemas.`, `attestations.`, `verdicts.`, `credentials.`, `staking.`, `token.` and the resolvers `whitelist.`, `fee.`, `gated.`, `reward.`, `pipeline.` (accounts, code hashes and transactions in [deployments/testnet.json](deployments/testnet.json)) |
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

Requirements: Node 22, pnpm 10, Rust (the toolchain is pinned in `contracts/rust-toolchain.toml`), Docker for Postgres and the reproducible build.

```bash
pnpm install && pnpm build
pnpm test                 # every TypeScript suite
pnpm test:contracts       # every contract unit test
pnpm dev                  # site on :3100, indexer, agent and services against testnet
```

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

```bash
pnpm verify
```

`pnpm verify` checks every claim in this README against the live deployment and prints PASS or FAIL for each: the test suites, the deployed code against the recorded hashes and a reproducible build of the recorded commit, the well-known schemas, a light client proof of a recent attestation, an AI-checked attestation's signatures, a cross-chain attestation, an agent's reputation, the indexer's lag, and the site, MCP and service health.

By hand, for any contract:

```bash
near contract verify deployed-at attestations.attestra.testnet network-config testnet now
```

## Trust and privacy model

- **What is public:** every attestation's schema, subject, attester and data. Never put secrets or raw evidence in attestation data.
- **What stays private:** evidence for a private check is encrypted in the browser to the NEAR AI model's key; the chain stores only the verdict, the rule, the model and the evidence hash.
- **Whom you trust for an AI verdict:** the model's signing key, published by NEAR AI Cloud from inside its TEE, and the checker key that the verdicts contract's owner allowlisted. The contract checks both signatures and that the NEAR AI signature covers the exact request it was given.
- **Whom you trust for a foreign event:** the NEAR MPC network's key; the contract recomputes the signed payload hash itself.
- **Whom you trust for "final":** NEAR's validators, through a light client proof you check yourself.
- **Contract owners** can change allowlisted keys and resolver settings; reviews, fixes and accepted risks are in [SECURITY.md](SECURITY.md).

## Hackathon tracks

- **Privacy and Private AI:** private facts checked by verifiable AI with end-to-end encryption; only a verdict and a hash go on chain.
- **Agent Economy:** Know Your Agent identity, scoped delegation and reviews; MCP and A2A interfaces; x402 paid verification.
- **Social Money:** gasless issuing, passkey accounts and credentials that let communities vouch for people and gate rewards.
- **Open Innovation:** cross-chain facts with no oracle through Chain Signatures, and light client proofs any client can check.

## Repository

<img src="assets/readme/repository.png" alt="What is in the repository: Rust contracts with the resolver gate and the verdicts contract, the TypeScript SDK, CLI and MCP packages, and the web, indexer and agent apps with the relayer, keeper and top-up services" width="960">

<img src="assets/readme/tree.png" alt="Annotated repository tree, with the verdicts contract's AI, foreign-transaction, MPC and wallet-link modules highlighted" width="960">

Mainnet is one switch away and not deployed: see [MAINNET.md](MAINNET.md).

## License

[MIT](LICENSE)

---
name: attestra
description: Use and extend Attestra, the attestation protocol on NEAR. Use when an agent must check whether a claim, credential or AI agent can be trusted on NEAR (read an attestation, verify it is active, prove its event final with a light client proof, read an agent's identity and reputation), issue or revoke attestations, register schemas, delegate issuing to an agent, run a private fact check with verifiable AI, or attest an event on another chain. Also use when changing the Attestra contracts, SDK, CLI or MCP server.
---

# Attestra

Attestra stores claims on NEAR as attestations: an attester says something about a subject (a NEAR account or a CAIP-10 account on another chain) under a schema that defines the fields.
Testnet contracts live under `attestra.testnet` (`schemas.`, `attestations.`, `verdicts.`, `credentials.`, `staking.`, `token.`, and the resolvers `whitelist.`, `fee.`, `gated.`, `reward.`, `pipeline.`).

Install this skill for Claude Code or Codex with `npx skills add ./skills/attestra` from a clone (or point `npx skills add` at the repository once it is public).

## Fastest path for an agent: MCP

From a clone (`pnpm install && pnpm build`), until the package is on npm:

```bash
claude mcp add attestra -- node /path/to/attestra/packages/mcp/dist/cli.js   # Claude Code
codex mcp add attestra -- node /path/to/attestra/packages/mcp/dist/cli.js    # Codex
```

After the npm release, `npx -y @attestra/mcp` replaces the path, for example in `~/.codex/config.toml`:

```toml
[mcp_servers.attestra]
command = "npx"
args = ["-y", "@attestra/mcp"]
```

Read tools need nothing.
Write tools appear when `ATTESTRA_ACCOUNT_ID` and `ATTESTRA_PRIVATE_KEY` (a testnet account) are set, and are capped per tool and per day.
A hosted, read-only endpoint is at `<site>/mcp` (Streamable HTTP).

| Tool | Use it to |
|---|---|
| `verify_attestation` | answer "is this claim valid right now?" (status: active, pending, revoking, revoked, expired) |
| `get_attestation`, `list_attestations` | read an attestation with its data decoded; list them by schema, attester or subject |
| `prove_attestation` | prove the event behind an attestation is in a final block (light client proof, checked locally) |
| `get_agent_reputation` | Know Your Agent: identity (owner, model, capabilities), delegations, reviews and average score |
| `get_authority`, `get_delegates` | who an issuer is, whether governance verified it, who may issue for it |
| `get_schema`, `list_schemas`, `well_known_schemas`, `compute_schema_uid`, `decode_data` | schemas and data |
| `linked_account`, `wallet_link_message` | find the NEAR account behind a wallet on another chain; get the text a wallet signs to link itself |
| `list_agent_keys` | which agents hold a function-call access key on an account, with their methods and gas allowance left |
| `register_schema`, `create_attestation`, `revoke_attestation`, `rate_agent` | write (testnet, capped) |
| `request_private_check` | prove a private fact (age, income, GitHub contributions) without revealing the evidence |
| `link_wallet` | link a wallet on another chain once it signed the link message (write) |
| `attest_foreign_event` | attest an EVM log the NEAR MPC network verified, no oracle (write, deposit capped) |
| `attest_foreign_instruction` | attest an inner instruction of a finalized Solana transaction the NEAR MPC network verified (devnet on testnet; write, deposit capped) |
| `register_agent`, `delegate_to_agent` | register an agent you own; let it attest for you within `expires_at` or `max_uses` (write) |
| `grant_agent_key` | give an agent a function-call key: attestations contract only, attest and revoke methods only, gas allowance capped (write) |
| `paid_verify` | buy a verified claim or agent check from the Attestra agent over x402 (write, payment capped) |

Decision rules:
- Trust a claim only when `verify_attestation` says `valid: true`; for high stakes also run `prove_attestation`.
- Trust an agent only with an active identity attestation; weigh `average_score` by `review_count`.
- Never put secrets or raw evidence in `create_attestation` values: attestations are public.
  Use `request_private_check`.

## SDK

```ts
import { AttestraClient, SchemaEncoder } from '@attestra/sdk';

const client = new AttestraClient({ network: 'testnet', accountId, privateKey, indexerUrl });
const { data } = await client.registerSchema({ definition: 'string name, u8 level', revocable: true });
const enc = new SchemaEncoder('string name, u8 level');
await client.createAttestation({ schemaUid: data!.schemaUid, subject: 'bob.testnet', data: enc.encode({ name: 'Bob', level: 3 }) });
```

Every method returns `{ success, data?, error?: { type, message }, txHash? }` and never throws.
Error types: `NOT_FOUND`, `UNAUTHORIZED`, `VALIDATION_ERROR`, `ALREADY_EXISTS`, `ALREADY_REVOKED`, `RESOLVER_REJECTED`, `EXPIRED`, `INSUFFICIENT_STORAGE`, `NETWORK_ERROR`, `CONFIGURATION_ERROR`, `TRANSACTION_ERROR`.
For an OpenAI-compatible agent (for example on NEAR AI Cloud, `https://cloud-api.near.ai/v1`): `openAITools()` and `runTool(client, name, args)`.

## CLI

`attestra <group> <command> --json`; groups: schema, blob, attestation, authority, storage, delegate, whitelist, fee, token-gated, token-reward, pipeline, credential, schedule, multisig, staking, token, events, check, chain, agent, pay, ai.
Signing commands take `-a <account>` and read the key from `~/.near-credentials/<network>/<account>.json` or `ATTESTRA_PRIVATE_KEY`.

## Schemas

Definitions are `type name` pairs separated by commas.
Types: `bool`, `u8`..`u128`, `i8`..`i128`, `string`, `account_id`, `bytes`, `bytes32`, and `T[]`.
Data is Borsh in field order (base64 on the wire).
Well-known schemas (UIDs are deterministic; `well_known_schemas` lists them): agent identity, agent review, private AI check, cross-chain event, wallet link, membership.

## Extending Attestra

- New resolver kind: add a module in `contracts/resolvers/src/`, implement `on_attest`, `on_revoke`, `on_aborted`, `on_committed`; never panic in a callback after changing state; add unit tests and a sandbox flow.
- New private-check rule: add it with `set_rules` on the verdicts contract (owner); the checkers build the prompt from the rule's on-chain claim, so a rule judged from evidence needs no code.
  A rule that fetches its own data (like the GitHub rules) needs code in both `apps/agent/src/check.ts` and `checker/src/check.rs`, and a new checker build means a new key: `set_enclave_keys` and `OUTLAYER_WASM_HASH`.
- New agent tool: add it to `packages/sdk/src/tools.ts`; the MCP server, the agent and `@attestra/sdk/ai` pick it up.
- Keep the UID vectors in `packages/sdk/test/uid.test.ts` and `contracts/common/src/uid.rs` in sync.
- Run `pnpm test`, `pnpm test:contracts` and `pnpm security` before proposing a change.

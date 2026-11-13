# @attestra/mcp

An MCP server that lets any AI agent read and issue attestations on NEAR with Attestra: verify a claim, prove it final, read an agent's identity and reputation, and, with a key, issue and revoke.

```bash
claude mcp add attestra -- npx -y @attestra/mcp       # Claude Code
npx -y @attestra/mcp --http 5600                       # Streamable HTTP on /mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.attestra]
command = "npx"
args = ["-y", "@attestra/mcp"]
```

## Tools

- Read, no key needed: `verify_attestation`, `get_attestation`, `prove_attestation`, `get_agent_reputation`, `list_attestations`, `get_authority`, `get_delegates`, `get_schema`, `list_schemas`, `well_known_schemas`, `compute_schema_uid`, `decode_data`, `linked_account`, `wallet_link_message`, `list_agent_keys`.
- Write, only when `ATTESTRA_ACCOUNT_ID` and `ATTESTRA_PRIVATE_KEY` are set, capped per tool and per day: `register_schema`, `create_attestation`, `revoke_attestation`, `rate_agent`, `request_private_check`, `attest_foreign_event`, `link_wallet`, `register_agent`, `delegate_to_agent`, `grant_agent_key`, `paid_verify`.

Only on NEAR:
- `linked_account` and `wallet_link_message` read wallet links; `link_wallet` links a wallet on another chain once it signed the link message.
- `attest_foreign_event` has the NEAR MPC network verify an EVM log (Chain Signatures) and attests it, with no oracle.
- `register_agent` and `delegate_to_agent` are Know Your Agent identity and an on-chain delegation; the tool refuses a delegation with neither `expires_at` nor `max_uses`.
- `grant_agent_key` adds a function-call access key the agent holds, limited to the attestations contract, the attest and revoke methods (`attest`, `revoke`, `schedule_revocation` by default) and a gas allowance; `list_agent_keys` shows which agents hold keys.
- `paid_verify` pays the Attestra agent over x402 for a verified claim or agent check.

Attestations are public: never put secrets or raw evidence in `create_attestation`; use `request_private_check`.

## Caps and spend limits

Every write tool counts against `MCP_DAILY_CAP_PER_TOOL` (default 20) and `MCP_DAILY_CAP_TOTAL` (default 50) per UTC day.
`grant_agent_key` and `delegate_to_agent` default to 5 a day; `MCP_DAILY_CAP_<TOOL>` (for example `MCP_DAILY_CAP_GRANT_AGENT_KEY`) sets any tool's cap, and the lower of it and the per-tool cap applies.
Each call also stays within a spend limit, checked before anything is sent:

| Setting | Limits | Default |
|---|---|---|
| `MCP_MAX_KEY_ALLOWANCE_NEAR` | the gas allowance `grant_agent_key` gives a key | 1 NEAR |
| `MCP_MAX_DEPOSIT_NEAR` | the deposit `link_wallet` and `attest_foreign_event` attach | 0.25 NEAR |
| `MCP_MAX_PAYMENT` | one `paid_verify` payment, in the token's smallest unit | 5 test tokens on testnet, 0.05 USDC on mainnet |

## Settings

`NEAR_NETWORK` (`testnet` or `mainnet`), `ATTESTRA_ROOT`, `ATTESTRA_RPC_URL`, `ATTESTRA_INDEXER_URL`, `ATTESTRA_AGENT_URL`, `ATTESTRA_RELAYER_URL` (on testnet they default to the hosted services at `https://api.attestra.site`).

License: MIT.

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

- Read, no key needed: `verify_attestation`, `get_attestation`, `prove_attestation`, `get_agent_reputation`, `list_attestations`, `get_authority`, `get_delegates`, `get_schema`, `list_schemas`, `well_known_schemas`, `compute_schema_uid`, `decode_data`.
- Write, only when `ATTESTRA_ACCOUNT_ID` and `ATTESTRA_PRIVATE_KEY` are set, capped per tool and per day: `register_schema`, `create_attestation`, `revoke_attestation`, `rate_agent`, `request_private_check`.

Attestations are public: never put secrets or raw evidence in `create_attestation`; use `request_private_check`.

## Settings

`NEAR_NETWORK` (`testnet` or `mainnet`), `ATTESTRA_ROOT`, `ATTESTRA_RPC_URL`, `ATTESTRA_INDEXER_URL`, `ATTESTRA_AGENT_URL`, `ATTESTRA_RELAYER_URL`.

License: MIT.

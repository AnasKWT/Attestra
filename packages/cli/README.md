# @attestra/cli

The `attestra` command line for Attestra, the attestation protocol on NEAR.

```bash
npm install -g @attestra/cli
attestra attestation verify <uid> --json
```

Every command takes `--json` and prints one JSON object, so scripts and agents can read it.

Command groups: `schema`, `blob`, `attestation`, `authority`, `storage`, `delegate`, `whitelist`, `fee`, `token-gated`, `token-reward`, `pipeline`, `credential`, `schedule`, `multisig`, `dao`, `staking`, `token`, `events`, `check`, `chain`, `agent`, `pay`, `ai`.
Run `attestra <group> --help` for the commands in each.

## Agent keys

`agent grant-key <publicKey> [--methods attest,revoke] [--allowance 0.25]` adds a NEAR function-call access key the agent holds to your account.
It works only on the attestations contract, only for the listed methods (default `attest,revoke,schedule_revocation`; storage, delegation and owner methods are refused) and only up to the allowance of gas in NEAR.
`agent keys <account>` lists the agent keys of an account and `agent revoke-key <publicKey>` deletes one (never a full-access key).
`agent delegate <agent>` is the contract-level alternative.

## Signing

Commands that write take `-a <account>`.
The key comes from `ATTESTRA_PRIVATE_KEY`, or from the NEAR CLI keychain at `~/.near-credentials/<network>/<account>.json`.

## Settings

| Flag | Environment | Default |
|---|---|---|
| `--network` | `ATTESTRA_NETWORK` or `NEAR_NETWORK` | `testnet` |
| `--root` | `ATTESTRA_ROOT` | `attestra.testnet` |
| `--rpc` | `ATTESTRA_RPC_URL` | the network's RPC |
| `--indexer` | `ATTESTRA_INDEXER_URL` | `https://api.attestra.site/indexer` on testnet, `http://localhost:5100` on mainnet |
| `--relayer` | `ATTESTRA_RELAYER_URL` | `https://api.attestra.site/relayer` on testnet, `http://localhost:5200` on mainnet |
| `--agent` | `ATTESTRA_AGENT_URL` | `https://api.attestra.site/agent` on testnet, `http://localhost:5300` on mainnet |

License: MIT.

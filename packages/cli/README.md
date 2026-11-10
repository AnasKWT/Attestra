# @attestra/cli

The `attestra` command line for Attestra, the attestation protocol on NEAR.

```bash
npm install -g @attestra/cli
attestra attestation verify <uid> --json
```

Every command takes `--json` and prints one JSON object, so scripts and agents can read it.

Command groups: `schema`, `blob`, `attestation`, `authority`, `storage`, `delegate`, `whitelist`, `fee`, `token-gated`, `token-reward`, `pipeline`, `credential`, `schedule`, `multisig`, `staking`, `token`, `events`, `check`, `chain`, `agent`, `pay`, `ai`.
Run `attestra <group> --help` for the commands in each.

## Signing

Commands that write take `-a <account>`.
The key comes from `ATTESTRA_PRIVATE_KEY`, or from the NEAR CLI keychain at `~/.near-credentials/<network>/<account>.json`.

## Settings

| Flag | Environment | Default |
|---|---|---|
| `--network` | `ATTESTRA_NETWORK` or `NEAR_NETWORK` | `testnet` |
| `--root` | `ATTESTRA_ROOT` | `attestra.testnet` |
| `--rpc` | `ATTESTRA_RPC_URL` | the network's RPC |
| `--indexer` | `ATTESTRA_INDEXER_URL` | `http://localhost:5100` |
| `--relayer` | `ATTESTRA_RELAYER_URL` | `http://localhost:5200` |
| `--agent` | `ATTESTRA_AGENT_URL` | `http://localhost:5300` |

License: MIT.

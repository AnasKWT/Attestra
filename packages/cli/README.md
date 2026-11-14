# attestra-cli

The `attestra` command line for Attestra, the attestation protocol on NEAR.

[Website](https://attestra.site) · [Docs](https://attestra.site/docs) · [Sandbox](https://attestra.site/sandbox/app) · [GitHub](https://github.com/AnasKWT/Attestra) · [llms.txt](https://attestra.site/llms.txt)

On testnet it talks to the live contracts and the hosted services out of the box, so nothing else needs to run.

```bash
npm install -g attestra-cli
attestra attestation verify <uid> --json
```

Every command takes `--json` and prints one JSON object, so scripts and agents can read it.

Command groups: `schema`, `blob`, `attestation`, `authority`, `storage`, `delegate`, `whitelist`, `fee`, `token-gated`, `token-reward`, `pipeline`, `credential`, `schedule`, `multisig`, `dao`, `staking`, `token`, `events`, `check`, `chain`, `agent`, `pay`, `ai`.
Run `attestra <group> --help` for the commands in each.

## A few examples

```bash
attestra schema list --json                                     # read, no key needed
attestra events prove <uid>                                     # a light client proof, checked locally
attestra -a alice.testnet check run age_over_18 --evidence @id.txt   # a private check about your own account
attestra -a alice.testnet dao request-membership --role member  # a membership the deployment DAO issues
attestra -a alice.testnet pay verify-claim <uid>                # x402: pay per verified claim
```

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
| | `ATTESTRA_KEEPER_URL` | `https://api.attestra.site/keeper` on testnet, `http://localhost:5400` on mainnet |

License: MIT.

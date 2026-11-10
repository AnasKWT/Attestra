# Attestra checker

A WASI P2 component for [NEAR OutLayer](https://app.outlayer.ai/docs) that runs a private AI check and signs the verdict with a key bound to its own build.
It does what `apps/agent/src/check.ts` does, so the verdicts contract accepts its verdicts exactly like the agent's:

1. It reads the rule by id from the verdicts contract (`get_rules` over NEAR RPC), so a caller names a rule but cannot rewrite its claim.
2. For GitHub rules it fetches the merged pull request count from `api.github.com` itself.
3. It encrypts the rule prompt to the attested model key and calls a NEAR AI Cloud verifiable model with end-to-end encryption (protocol v2: X25519, HKDF-SHA256 with info `ed25519_encryption`, XChaCha20-Poly1305), byte compatible with `packages/sdk/src/e2ee.ts`.
4. It decrypts the one-word answer with an ephemeral key and checks the model's ed25519 signature over `model:request_hash:response_hash` against the attested key, including both hashes.
5. It builds the `AiVerdict` and signs `verdict_digest` (sha256 of the Borsh tuple in `contracts/verdicts/src/ai.rs`) with its OutLayer signing key.

## Input and output

The program reads one JSON object on stdin and prints one JSON object on stdout.

| Input | Output |
|---|---|
| `{"operation": "public_key"}` | `{"enclaveKey": "ed25519:..."}` |
| `{"operation": "check", "request_id", "rule_id", "subject", "model", "encrypted_evidence", "github"}` | `CheckOutput` of `apps/agent/src/check.ts`: `verdict`, `enclaveKey`, `enclaveSignature`, `nearai`, `answer` |

Any failure prints `{"error": "..."}`.
The network comes from `NEAR_NETWORK_ID`, which the OutLayer worker sets and callers cannot: testnet reads `verdicts.attestra.testnet`, mainnet reads `verdicts.attestra.near`.
`NEARAI_API_KEY` (required for checks) and `GITHUB_TOKEN` (optional) come from the caller's OutLayer secrets.

## The key

`manifest.json` is embedded in the wasm as the `outlayer.manifest` custom section and declares one [signing key](https://github.com/fastnear/near-outlayer/blob/main/wasi-examples/CONNECTOR_MANIFEST.md#signing_keys-keys-the-module-signs-with): `{"path": "verdicts", "type": "ed25519", "bind": "wasm", "caller": "none"}`.
OutLayer's keystore derives it inside the TEE as HMAC-SHA256(master, `signing-key:v1:ed25519:wasm:{wasm_sha256}:none:verdicts`), and the program only ever asks the host to sign.
So the key belongs to these exact bytes: another build, including a changed manifest, gets another key, and nobody, Attestra included, can make other code sign with it.
OutLayer issues a `bind: "wasm"` key only to a direct run of a published wasm URL, which is started on chain (`request_execution` with a `WasmUrl` source).
OutLayer's HTTPS API runs projects only, and a project key (`bind: "project"`) survives code upgrades, so it would be bound to whoever publishes versions, not to the build.
The key signs only the verdict digest, a structure this program composes under the fixed `attestra:verdict:v1` tag.

## Build

```bash
checker/build.sh --reproducible   # OutLayer's pinned compiler image (linux/amd64): the bytes to publish
checker/build.sh                  # local toolchain, for development (another hash)
```

Both print the wasm path and its sha256.
The reproducible build runs OutLayer's own wasm32-wasip2 recipe (`cargo build --release --locked`, then `wasm-tools strip` keeping `outlayer.manifest`) in the compiler image pinned by digest, so anyone can rebuild a commit and compare the hash.

## Test

```bash
cd checker && cargo test && cargo clippy --all-targets -- -D warnings
cargo clippy --release --target wasm32-wasip2 -- -D warnings
```

The tests run natively against a mocked host (NEAR AI Cloud, NEAR RPC, GitHub and the signing key).
`tests/fixtures/ts.json` holds vectors computed by the TypeScript code; regenerate it after changing either side with `apps/agent/node_modules/.bin/tsx checker/scripts/fixtures.ts`.

## Publish and run on OutLayer

With the [OutLayer CLI](https://github.com/fastnear/near-outlayer/blob/main/docs/CLI.md), logged in as the agent account:

```bash
outlayer upload checker/target/outlayer/attestra-checker.wasm        # prints the FastFS URL
outlayer secrets set '{"NEARAI_API_KEY":"..."}' --wasm-hash <sha256> --profile default --access whitelist:agent.attestra.testnet
outlayer run --wasm <FastFS URL> --hash <sha256> '{"operation":"public_key"}'
```

The last command prints the key; the run's TEE attestation (`/attestations/by-tx/{tx_hash}` on the OutLayer API) binds that output to the wasm hash.
Then set the agent's `CHECKER_MODE=outlayer`, `OUTLAYER_WASM_URL`, `OUTLAYER_WASM_HASH` and `OUTLAYER_SECRETS_PROFILE` (see `apps/agent/.env.example`).
For each check the agent calls `request_execution` on `outlayer.testnet` (or `outlayer.near`) with the estimated cost attached, verifies the signed verdict, and submits it with `submit_ai_verdict`.

## Register the key with the verdicts contract

The owner adds the key with `set_enclave_keys`, which replaces the whole list (at most 10 keys, one yoctoNEAR attached):

```bash
near contract call-function as-transaction verdicts.attestra.testnet set_enclave_keys \
  json-args '{"keys":["ed25519:<checker key>"]}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as attestra.testnet network-config testnet sign-with-keychain send
```

Keep any keys still in use in the list, and drop the key of a build that is retired.
`scripts/deploy.ts` does the same when `ENCLAVE_PUBLIC_KEY` is set.

## Limits

- The encrypted evidence travels in the `request_execution` arguments, so its ciphertext is public on chain; only the model's TEE key opens it.
- The rule is read from a FastNEAR RPC endpoint without a light client proof.
- A verdict does not name who asked for the check: the contract's digest has no caller field, and the key answers every caller of this build alike.

#!/usr/bin/env bash
# Builds every contract and test double the sandbox tests deploy, into
# contracts/target/near/<crate>/<crate>.wasm. Works with macOS bash 3.2.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"

crates="schemas attestations resolvers credentials staking token verdicts sandbox-tests/doubles/mpc sandbox-tests/doubles/resolver"

for crate in $crates; do
  echo "==> building $crate"
  (cd "$root/$crate" && cargo near build non-reproducible-wasm --no-abi)
done

# cargo near can leave an ABI scratch folder behind.
rm -rf "$root/target/cargo-near-abi"

echo "==> wasm files"
ls -l "$root"/target/near/*/*.wasm

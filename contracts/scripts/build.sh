#!/usr/bin/env bash
# Builds every deployable contract to wasm.
#
#   scripts/build.sh                       local toolchain, to target/near/<crate>/<crate>.wasm (fast; for tests)
#   scripts/build.sh --reproducible [rev]  SourceScan's pinned Docker image (each crate's
#                                          [package.metadata.near.reproducible_build]) from commit `rev`
#                                          (default HEAD), to target/near-reproducible/<commit>/<crate>.wasm.
#                                          The wasm embeds NEP-330 metadata naming the repository and the
#                                          commit, so `near contract verify` and NearBlocks can rebuild it.
#
# The reproducible build checks the commit out in a temporary git worktree, so uncommitted changes
# never reach it. It needs Docker. Bash 3.2 compatible.
set -euo pipefail
cd "$(dirname "$0")/.."

CRATES="schemas attestations resolvers credentials staking verdicts token"

case "${1:-}" in
  "")
    for c in $CRATES; do
      (cd "$c" && cargo near build non-reproducible-wasm --no-abi --locked >/dev/null 2>&1) || {
        echo "build failed: $c" >&2
        (cd "$c" && cargo near build non-reproducible-wasm --no-abi --locked)
        exit 1
      }
      echo "built $c"
    done
    rm -rf target/cargo-near-abi
    for c in $CRATES; do ls -l "target/near/attestra_$c/attestra_$c.wasm" | awk '{print $5, $9}'; done
    ;;
  --reproducible)
    rev=$(git rev-parse "${2:-HEAD}^{commit}")
    out="target/near-reproducible/$rev"
    tree=$(mktemp -d "${TMPDIR:-/tmp}/attestra-build.XXXXXX")
    git worktree add --detach "$tree" "$rev" >/dev/null
    trap 'git worktree remove --force "$tree" >/dev/null 2>&1 || true' EXIT
    mkdir -p "$out"
    for c in $CRATES; do
      (cd "$tree/contracts/$c" && cargo near build reproducible-wasm >"$tree/build-$c.log" 2>&1) || {
        echo "reproducible build failed: $c" >&2
        tail -40 "$tree/build-$c.log" >&2
        exit 1
      }
      cp "$tree/contracts/target/near/attestra_$c/attestra_$c.wasm" "$out/"
      echo "built $c at ${rev:0:12}"
    done
    ls -l "$out"/*.wasm | awk '{print $5, $9}'
    ;;
  *) echo "usage: scripts/build.sh [--reproducible [rev]]" >&2; exit 1 ;;
esac

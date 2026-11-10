#!/usr/bin/env bash
# Builds the checker component and prints its sha256 (the hash its signing key is bound to).
#
#   checker/build.sh                  local toolchain, for development (a different hash)
#   checker/build.sh --reproducible   OutLayer's pinned compiler image (amd64), the bytes to publish
#
# The reproducible build follows OutLayer's wasm32-wasip2 recipe: `cargo build --release --locked`,
# then `wasm-tools strip` with the platform's delete list, which keeps the `outlayer.manifest`
# section. Anyone who runs it on the same commit gets the same bytes, so the published hash, and
# with it the checker key, can be traced to this source.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/target/outlayer"
TARGET=wasm32-wasip2
# outlayer/wasmedge-compiler (rust 1.97, wasm-tools), linux/amd64, pinned by digest. Source:
# scripts/build_github_wasm.sh in github.com/fastnear/near-outlayer.
IMAGE="${OUTLAYER_COMPILER_IMAGE:-outlayer/wasmedge-compiler@sha256:d9eb7bd9bab6c46b77f309ec33e94ca112883268a848dd1929289fade799cd27}"
STRIP='^(\.debug_.*|producers|target_features|linking|reloc\..*|sourceMappingURL|external_debug_info|component-name)$'

check_manifest() {
  if ! grep -qa 'outlayer.manifest' "$1"; then
    echo "ERROR: the outlayer.manifest section is missing from $1" >&2
    exit 1
  fi
}

mkdir -p "$OUT"

if [ "${1:-}" = "--reproducible" ]; then
  command -v docker >/dev/null || { echo "docker is required for --reproducible" >&2; exit 2; }
  docker pull -q "$IMAGE" >/dev/null
  ARCH=$(docker image inspect "$IMAGE" --format '{{.Architecture}}')
  [ "$ARCH" = "amd64" ] || { echo "the compiler image resolved to $ARCH, not amd64: the bytes would differ" >&2; exit 1; }
  docker run --rm -i -e "STRIP=$STRIP" -v "$HERE:/src:ro" -v "$OUT:/out" "$IMAGE" sh -eu -c '
    if [ -f /usr/local/cargo/env ]; then . /usr/local/cargo/env; fi
    rustup target add wasm32-wasip2 >/dev/null 2>&1
    mkdir -p /workspace/repo && cp -a /src/. /workspace/repo/ && cd /workspace/repo && rm -rf target
    cargo build --release --target wasm32-wasip2 --locked >&2
    wasm-tools strip --delete "$STRIP" target/wasm32-wasip2/release/attestra-checker.wasm -o /out/attestra-checker.wasm
    echo "toolchain $(rustc -V)" >&2
  '
else
  (cd "$HERE" && cargo build --release --target "$TARGET" --locked)
  cp "$HERE/target/$TARGET/release/attestra-checker.wasm" "$OUT/attestra-checker.wasm"
  echo "note: local toolchain build; publish the --reproducible build" >&2
fi

WASM="$OUT/attestra-checker.wasm"
check_manifest "$WASM"
HASH=$(shasum -a 256 "$WASM" | cut -d' ' -f1)
echo "wasm:   $WASM"
echo "sha256: $HASH"

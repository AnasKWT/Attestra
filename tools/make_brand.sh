#!/usr/bin/env bash
# Brand files in assets/brand, rendered from the site's own mark (apps/web/src/app/icon.svg),
# so the README, the npm pages and the site cannot show different logos.
# Needs rsvg-convert (librsvg). Run from anywhere: tools/make_brand.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/apps/web/src/app/icon.svg"
out="$root/assets/brand"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert is missing (brew install librsvg)"; exit 2; }
mkdir -p "$out"
cp "$src" "$out/mark.svg"
for size in 32 64 128 256 512 1024; do
  rsvg-convert -w "$size" -h "$size" "$src" -o "$out/mark-$size.png"
done
echo "wrote $(ls "$out" | wc -l | tr -d ' ') files to assets/brand"

#!/usr/bin/env bash
# Brand files in assets/brand, rendered from the site's own mark (apps/web/src/app/icon.svg),
# so the README, the npm pages and the site cannot show different logos.
#   mark.svg                 the site's icon, ink that follows the viewer's colour scheme
#   mark-light.svg/-<n>.png  ink for light grounds; mark-dark.svg/-<n>.png  ink for dark grounds
#   tile-<n>.png             the app icon: the dark mark on an ink tile
# Needs rsvg-convert (librsvg). Run from anywhere: tools/make_brand.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/apps/web/src/app/icon.svg"
out="$root/assets/brand"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert is missing (brew install librsvg)"; exit 2; }
grep -q '@media (prefers-color-scheme:dark){.ink{stroke:#f5f2ee}}' "$src" || { echo "icon.svg changed shape; update this script"; exit 2; }
mkdir -p "$out"
rm -f "$out"/mark-*.png "$out"/tile-*.png
cp "$src" "$out/mark.svg"
sed 's/@media (prefers-color-scheme:dark){.ink{stroke:#f5f2ee}}//' "$src" >"$out/mark-light.svg"
sed -e 's/@media (prefers-color-scheme:dark){.ink{stroke:#f5f2ee}}//' -e 's/.ink{stroke:#1c1917}/.ink{stroke:#f5f2ee}/' "$src" >"$out/mark-dark.svg"
# The tile: the dark mark at 78% on a rounded ink square.
inner=$(sed -e 's/^<svg[^>]*>//' -e 's#</svg>$##' "$out/mark-dark.svg")
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1c1917"/><g transform="translate(32 32) scale(0.78) translate(-32 -32)">%s</g></svg>\n' "$inner" >"$out/tile.svg"
for size in 32 64 128 256 512 1024; do
  rsvg-convert -w "$size" -h "$size" "$out/mark-light.svg" -o "$out/mark-light-$size.png"
  rsvg-convert -w "$size" -h "$size" "$out/mark-dark.svg" -o "$out/mark-dark-$size.png"
  rsvg-convert -w "$size" -h "$size" "$out/tile.svg" -o "$out/tile-$size.png"
done
echo "wrote $(ls "$out" | wc -l | tr -d ' ') files to assets/brand"

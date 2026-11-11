# Brand

- The mark is a check drawn in two flat strokes, the short one in orange and the long one in ink, slid apart by a thin cut where they meet, inside a hexagon outline in ink that opens at its upper-right corner where the long stroke leaves it: a claim, checked, breaking out of its frame.
- It is flat and two-coloured on a 64-unit grid, so it reads the same at 16 px, on paper and on either colour scheme.
- `mark.svg` is the site's `apps/web/src/app/icon.svg`, whose ink follows the viewer's colour scheme.
- `mark-light.svg` and `mark-light-<size>.png` are for light grounds (ink `#1c1917`); `mark-dark.svg` and `mark-dark-<size>.png` are for dark grounds (ink `#f5f2ee`).
- `tile.svg` and `tile-<size>.png` are the app icon: the dark mark on a rounded ink square.
- The check is `#f97316` everywhere; the wordmark is "Attestra" with "ra" in the accent colour (`#ea580c` on light, `#fb923c` on dark).
- The geometry lives in `apps/web/src/components/brand/mark.ts`; a unit test keeps `icon.svg` in step with it.

- `backup-tick/` keeps the two-stroke check on its own, without the hexagon.
- `backup-hexagon/` keeps the first mark (an open hexagon with a single orange check).

Regenerate with `tools/make_brand.sh`, then the README images with `tools/.venv/bin/python -m tools.make_readme_art`.

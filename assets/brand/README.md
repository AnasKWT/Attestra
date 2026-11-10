# Brand

- The mark is a hexagon drawn as one ink stroke, open at the upper right, with an orange check that leaves through the opening: a claim that is checked and sealed, and proof that it holds outside the system that issued it.
- It is flat and two-coloured on a 64-unit grid, so it reads the same at 16 px, on paper and on either colour scheme.
- `mark.svg` is the site's `apps/web/src/app/icon.svg`, whose ink follows the viewer's colour scheme.
- `mark-light.svg` and `mark-light-<size>.png` are for light grounds (ink `#1c1917`); `mark-dark.svg` and `mark-dark-<size>.png` are for dark grounds (ink `#f5f2ee`).
- `tile.svg` and `tile-<size>.png` are the app icon: the dark mark on a rounded ink square.
- The check is `#f97316` everywhere; the wordmark is "Attestra" with "ra" in the accent colour (`#ea580c` on light, `#fb923c` on dark).
- The geometry lives in `apps/web/src/components/brand/mark.ts`; a unit test keeps `icon.svg` in step with it.

Regenerate with `tools/make_brand.sh`, then the README images with `tools/.venv/bin/python -m tools.make_readme_art`.

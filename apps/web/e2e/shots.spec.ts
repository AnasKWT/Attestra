/** Screenshot sweep (@shots, run with `pnpm e2e:shots`): every route in light, dark and at 375px, saved to internal/qa/shots/. */

import { fileURLToPath } from 'node:url';
import { NOT_FOUND, PAGES } from './routes';
import { expect, settled, test } from './support';

const OUT = fileURLToPath(new URL('../../../internal/qa/shots/', import.meta.url));

const VARIANTS = [
  { name: 'light', theme: 'light', viewport: { width: 1440, height: 900 } },
  { name: 'dark', theme: 'dark', viewport: { width: 1440, height: 900 } },
  { name: 'mobile', theme: 'light', viewport: { width: 375, height: 812 } },
] as const;

const file = (path: string) => (path === '/' ? 'home' : path.slice(1).replace(/[^a-zA-Z0-9.-]+/g, '_')).slice(0, 120);

for (const v of VARIANTS) {
  test.describe(`${v.name} @shots`, () => {
    // Reduced motion shows scroll-reveal sections at once, so full-page images include them.
    test.use({ viewport: v.viewport, reducedMotion: 'reduce' });
    for (const r of [...PAGES, NOT_FOUND]) {
      test(`${v.name} ${r.path}`, async ({ page, diagnostics }) => {
        if (r === NOT_FOUND) diagnostics.allow(/^Failed to load resource: the server responded with a status of 404/);
        await page.addInitScript((t) => localStorage.setItem('attestra.theme', t), v.theme);
        await page.goto(r.path);
        await settled(page, r.ready);
        await expect(page.locator('html')).toHaveAttribute('data-theme', v.theme);
        await page.screenshot({ path: `${OUT}${v.name}/${file(r.path)}.png`, fullPage: true, animations: 'disabled' });
      });
    }
  });
}

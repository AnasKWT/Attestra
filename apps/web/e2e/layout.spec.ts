/** No page scrolls sideways on a phone or on a wide desktop. */

import { NOT_FOUND, PAGES } from './routes';
import { expect, settled, test } from './support';

for (const width of [375, 1440]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: width < 768 ? 812 : 900 } });
    for (const r of [...PAGES, NOT_FOUND]) {
      test(`${r.path} has no horizontal scroll at ${width}px`, async ({ page, diagnostics }) => {
        if (r === NOT_FOUND) diagnostics.allow(/^Failed to load resource: the server responded with a status of 404/);
        await page.goto(r.path);
        await settled(page, r.ready);
        const { scrollWidth, innerWidth, wide } = await page.evaluate(() => {
          const w = window.innerWidth;
          // Elements that stick out past the viewport outside any scroll container, to name the culprit.
          const clipped = (el: Element) => {
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true;
            return false;
          };
          const wide = [...document.querySelectorAll('body *')]
            .filter((el) => el.getBoundingClientRect().right > w + 1 && !clipped(el))
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}.${String(el.getAttribute('class')).slice(0, 80)}`);
          return { scrollWidth: document.scrollingElement!.scrollWidth, innerWidth: w, wide };
        });
        expect(scrollWidth, `overflowing: ${wide.join(' | ')}`).toBeLessThanOrEqual(innerWidth);
      });
    }
  });
}

test('a focused text field shows its own ring, not the global focus outline', async ({ page }) => {
  await page.goto('/sandbox/app/lookup');
  const field = page.locator('#uid');
  await field.focus();
  await expect(field).toBeFocused();
  expect(await field.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
  expect(await field.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
});

test('a focused link keeps the global focus outline', async ({ page }) => {
  await page.goto('/about');
  await page.keyboard.press('Tab');
  const link = page.getByRole('link', { name: 'Attestra home' });
  await expect(link).toBeFocused();
  expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
});

test('a select shows its dropdown chevron', async ({ page }) => {
  await page.goto('/sandbox/app/schema-builder');
  const select = page.locator('#resolver');
  await expect(select).toBeVisible();
  expect(await select.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('data:image/svg+xml');
});

for (const width of [375, 672]) {
  test(`the sign-in menu of a sandbox tool stays on screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/sandbox/app/create-attestation');
    await settled(page);
    await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await expect(menu.getByRole('button', { name: 'New here? Create a passkey account' })).toBeVisible();
  });
}

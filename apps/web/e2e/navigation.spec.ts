import { NOT_FOUND, PAGES } from './routes';
import { expect, settled, test } from './support';

const NAV = [
  ['Schemas', '/products/schema'],
  ['Attestations', '/products/attestation'],
  ['Only on NEAR', '/near'],
  ['Explorer', '/attestations'],
  ['Sandbox', '/sandbox'],
  ['Docs', '/docs'],
] as const;

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the navbar links open their pages', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const [label, href] of NAV) {
      await nav.getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(href);
      await settled(page);
    }
    await page.getByRole('link', { name: 'Attestra home' }).click();
    await expect(page).toHaveURL('/');
  });

  test('the explorer tabs switch lists', async ({ page }) => {
    await page.goto('/attestations');
    const tabs = page.getByRole('navigation', { name: 'Explorer' });
    for (const [label, href] of [['Schemas', '/schemas'], ['Authorities', '/authorities'], ['Agents', '/agents'], ['Audit log', '/audit-log'], ['Attestations', '/attestations']]) {
      await tabs.getByRole('link', { name: label }).click();
      await expect(page).toHaveURL(href);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(label);
    }
  });

  test('the sandbox sidebar opens each tool', async ({ page }) => {
    await page.goto('/sandbox/app');
    const side = page.getByRole('complementary', { name: 'Sandbox tools' });
    await side.getByRole('link', { name: 'Schema Encoder' }).click();
    await expect(page).toHaveURL('/sandbox/app/schema-encoder');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Schema Encoder');
    await side.getByRole('link', { name: 'Lookup' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lookup');
    await side.getByRole('link', { name: 'All tools' }).click();
    await expect(page).toHaveURL('/sandbox/app');
  });

  test('the docs table of contents jumps to each section', async ({ page }) => {
    await page.goto('/docs');
    const toc = page.getByRole('navigation', { name: 'Documentation' });
    const links = toc.getByRole('link');
    const n = await links.count();
    expect(n).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < n; i++) {
      const link = links.nth(i);
      const id = (await link.getAttribute('href'))!.slice(1);
      await link.click();
      await expect(page).toHaveURL(`/docs#${id}`);
      const heading = page.locator(`[id="${id}"]`);
      await expect(heading).toHaveText((await link.textContent())!);
      await expect(heading).toBeInViewport();
    }
    await toc.getByRole('link', { name: 'CLI' }).click();
    await expect(toc.getByRole('link', { name: 'CLI' })).toHaveClass(/border-brand-500/);
  });

  test('a docs anchor opens scrolled to its section', async ({ page }) => {
    await page.goto('/docs#mcp');
    await expect(page.locator('#mcp')).toBeInViewport();
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the menu opens, navigates and closes', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
    const toggle = page.getByRole('button', { name: 'Open menu' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    const menu = page.getByRole('navigation', { name: 'Mobile' });
    await expect(menu).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    for (const [label] of NAV) await expect(menu.getByRole('link', { name: label, exact: true })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Search' })).toBeVisible();
    await menu.getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(page).toHaveURL('/docs');
    await expect(menu).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('navigation', { name: 'Mobile' }).getByRole('link', { name: 'Search' }).click();
    await expect(page).toHaveURL('/search');
    await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeHidden();
  });

  test('the menu closes with its button', async ({ page }) => {
    await page.goto('/near');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeHidden();
  });
});

test.describe('theme', () => {
  test('follows the system setting until chosen', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the toggle switches the theme and the choice survives a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
    await page.goto('/docs');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'light');
  });

  test('the dark theme paints a dark page', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/about');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g)!.map(Number);
    expect(r + g + b).toBeLessThan(120);
  });
});

test('the footer links to llms.txt as a file', async ({ page }) => {
  await page.goto('/about');
  await page.getByRole('contentinfo').getByRole('link', { name: 'llms.txt' }).click();
  await expect(page).toHaveURL('/llms.txt');
  await expect(page.locator('body')).toContainText('# Attestra');
});

test('every internal link on every page resolves, anchors included', async ({ request }) => {
  test.setTimeout(120_000);
  const html = new Map<string, string>();
  const get = async (path: string) => {
    if (!html.has(path)) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      html.set(path, await res.text());
    }
    return html.get(path)!;
  };
  const links = new Map<string, string>();
  for (const r of [...PAGES, NOT_FOUND]) {
    const body = r === NOT_FOUND ? await (await request.get(r.path)).text() : await get(r.path);
    for (const [, href] of body.matchAll(/<a[^>]+href="(\/[^"]*)"/g)) if (!links.has(href)) links.set(href, r.path);
  }
  expect(links.size).toBeGreaterThan(40);
  for (const [href, from] of links) {
    const url = new URL(href.replaceAll('&amp;', '&'), 'http://site');
    const body = await get(url.pathname + url.search).catch((e: Error) => {
      throw new Error(`${href} (linked from ${from}): ${e.message}`);
    });
    if (url.hash) expect(body, `${href} (linked from ${from}) has no #${url.hash.slice(1)}`).toContain(`id="${url.hash.slice(1)}"`);
  }
});

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/lib/tools';
import { FILES, NOT_FOUND, PAGES } from './routes';
import { expect, settled, test } from './support';

const APP_DIR = fileURLToPath(new URL('../src/app', import.meta.url));

/** Route patterns of every page.tsx under src/app (route groups dropped). */
function pagePatterns(dir = APP_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return pagePatterns(full);
    if (e.name !== 'page.tsx') return [];
    const segs = relative(APP_DIR, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s));
    return [`/${segs.join('/')}`];
  });
}

test('the route list covers every page in src/app', () => {
  const listed = new Set(PAGES.map((p) => p.pattern));
  expect(pagePatterns().filter((p) => !listed.has(p))).toEqual([]);
});

for (const r of PAGES) {
  test(`renders ${r.path}`, async ({ page }) => {
    const res = await page.goto(r.path);
    expect(res?.status()).toBe(200);
    await expect(page.locator('h1').first()).toHaveText(r.heading);
    await settled(page, r.ready);
    await expect(page).toHaveTitle(/Attestra/);
  });
}

test('an unknown path renders the not-found page with a 404', async ({ page, diagnostics }) => {
  diagnostics.allow(/^Failed to load resource: the server responded with a status of 404/);
  const res = await page.goto(NOT_FOUND.path);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NOT_FOUND.heading);
  await page.getByRole('main').getByRole('link', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/search$/);
});

for (const f of FILES) {
  test(`serves ${f.path}`, async ({ request }) => {
    const res = await request.get(f.path);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain(f.type);
    expect((await res.body()).length).toBeGreaterThan(100);
  });
}

test('the manifest names the site and its icons resolve', async ({ request }) => {
  const m = (await (await request.get('/manifest.webmanifest')).json()) as { name: string; icons?: Array<{ src: string }> };
  expect(m.name).toMatch(/Attestra/);
  for (const icon of m.icons ?? []) expect((await request.get(icon.src)).status(), icon.src).toBe(200);
});

test('the home page links its icons and share image', async ({ page, request }) => {
  await page.goto('/');
  const hrefs = await page.locator('head link[rel~="icon"], head link[rel="apple-touch-icon"], head link[rel="manifest"]').evaluateAll((ls) => ls.map((l) => (l as HTMLLinkElement).href));
  expect(hrefs.length).toBeGreaterThanOrEqual(3);
  const og = await page.locator('head meta[property="og:image"]').first().getAttribute('content');
  expect(og).toMatch(/\/opengraph-image/);
  for (const h of [...hrefs, new URL(new URL(og!).pathname, page.url()).href]) expect((await request.get(h)).status(), h).toBe(200);
});

test('the home page counts every sandbox tool', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('sandbox tools', { exact: true }).locator('..')).toContainText(String(TOOLS.length));
});

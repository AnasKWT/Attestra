/** With no deployment and no services, every read ends in a clear empty or error state. */

import { ATTESTATION_UID, SCHEMA_UID } from './routes';
import { expect, settled, test } from './support';

test('the home page stats say they are unavailable instead of loading forever', async ({ page }) => {
  await page.goto('/');
  await settled(page);
  await expect(page.getByText('Unavailable: the indexer and the contracts did not answer')).toBeVisible();
  await expect(page.locator('dl dd').filter({ hasText: 'n/a' })).toHaveCount(4);
});

for (const path of ['/attestations', '/schemas', '/authorities', '/agents', '/audit-log']) {
  test(`${path} explains that the indexer did not answer`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText('The indexer did not answer')).toBeVisible();
    await settled(page);
  });
}

test('a schema that is not on chain says so', async ({ page }) => {
  await page.goto(`/schemas/${SCHEMA_UID}`);
  await expect(page.getByText('Not found on chain')).toBeVisible();
  await expect(page.getByText(SCHEMA_UID)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Attest with this schema' })).toHaveCount(0);
});

test('an attestation that is not on chain says so', async ({ page }) => {
  await page.goto(`/attestations/${ATTESTATION_UID}`);
  await expect(page.getByText('Not found on chain')).toBeVisible();
  await settled(page);
});

test('an account that is not an authority says so', async ({ page }) => {
  await page.goto('/authorities/alice.testnet');
  await expect(page.getByText('Not a registered authority')).toBeVisible();
  await settled(page);
});

test('the status page marks every service down', async ({ page }) => {
  await page.goto('/status');
  await settled(page);
  for (const name of ['Indexer', 'Relayer', 'Agent', 'Keeper', 'Top-up']) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('healthy', { exact: true })).toHaveCount(0);
  await expect(page.getByText('The top-up service did not answer')).toBeVisible();
  await expect(page.getByText('checking', { exact: true })).toHaveCount(0);
});

test('search shows the indexer error and drops it when the query is cleared', async ({ page }) => {
  await page.goto('/search');
  const box = page.getByRole('main').getByRole('textbox', { name: 'Search' });
  const error = page.getByText('The indexer did not answer');
  await box.fill('alice.testnet');
  await expect(error).toBeVisible();
  await box.fill('');
  await expect(error).toHaveCount(0);
});

test('an account page shows the indexer error once per list', async ({ page }) => {
  await page.goto('/accounts/alice.testnet');
  await settled(page);
  await expect(page.getByText('The indexer did not answer')).toHaveCount(2);
  await expect(page.getByText('Failed to fetch', { exact: true })).toHaveCount(0);
});

test('an agent page explains that the indexer did not answer', async ({ page }) => {
  await page.goto('/agents/helper.alice.testnet');
  await expect(page.getByText('The indexer did not answer')).toBeVisible();
  await settled(page);
});

test('the navbar search opens the search page with the query', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('banner').getByRole('textbox', { name: 'Search' });
  await box.fill('alice.testnet');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=alice\.testnet$/);
  await expect(page.getByRole('main').getByRole('textbox', { name: 'Search' })).toHaveValue('alice.testnet');
});

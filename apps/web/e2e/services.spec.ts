/** Pages that read a running service, answered with the service's own response builders so the two cannot drift. */

import { balancesView } from '../../../services/src/topup/app';
import { expect, settled, test } from './support';

const NEAR = 10n ** 24n;

test("the status page shows the top-up service's balances in NEAR", async ({ page }) => {
  const view = balancesView(
    { network: 'testnet', accountId: 'treasury.attestra.testnet', treasuryWarn: 2n * NEAR, dailyCap: 10n * NEAR } as never,
    {
      at: new Date().toISOString(),
      treasury: 5n * NEAR,
      readings: [
        { kind: 'account', account: 'relayer.attestra.testnet', min: (3n * NEAR) / 2n, target: 3n * NEAR, balance: (2925n * NEAR) / 1000n },
        { kind: 'account', account: 'keeper.attestra.testnet', min: NEAR / 2n, target: NEAR, balance: NEAR / 10n },
        { kind: 'storage', account: 'verdicts.attestra.testnet', contract: 'attestations.attestra.testnet', min: NEAR / 2n, target: NEAR, balance: NEAR },
      ],
    },
    NEAR / 4n,
    '2026-11-10',
  );
  await page.route('http://localhost:5500/api/balances', (route) => route.fulfill({ json: view }));
  await page.goto('/status');
  await settled(page);
  const wallets = page.getByRole('list').filter({ hasText: 'treasury.attestra.testnet' });
  await expect(wallets.getByText('5 NEAR', { exact: true })).toBeVisible();
  await expect(wallets.getByText('2.925 NEAR', { exact: true })).toBeVisible();
  await expect(wallets.getByText('min 1.5 / target 3')).toBeVisible();
  await expect(wallets.getByText('verdicts.attestra.testnet on attestations.attestra.testnet')).toBeVisible();
  // The keeper is below its minimum.
  await expect(wallets.getByText('low', { exact: true })).toHaveCount(1);
  await expect(page.getByText('0.25 of 10 NEAR used today')).toBeVisible();
});

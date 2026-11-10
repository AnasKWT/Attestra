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

test('agent chat shows a verified answer and keeps working across turns', async ({ page }) => {
  let turns = 0;
  await page.route('http://localhost:5300/v1/chat', (route) => {
    turns++;
    return route.fulfill({
      json: {
        reply: turns === 1 ? 'Yes, that attestation is active.' : 'It was attested by verdicts.attestra.testnet.',
        tools: ['verify_attestation'],
        verification: { model: 'z-ai/glm-5.3-flash', chat_id: 'c1', verified: true, verify_url: 'https://cloud.near.ai/verify', signing_address: '0x3b75' },
      },
    });
  });
  await page.goto('/sandbox/app/agent-chat');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Is it valid?');
  await box.press('Enter');
  await expect(page.getByText('Yes, that attestation is active.')).toBeVisible();
  await box.fill('Who attested it?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('It was attested by verdicts.attestra.testnet.')).toBeVisible();
  await expect(page.getByText('signature verified by z-ai/glm-5.3-flash')).toHaveCount(2);
  await settled(page);
});

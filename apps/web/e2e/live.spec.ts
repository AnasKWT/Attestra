import { expect, test } from '@playwright/test';
import { AttestraClient, KNOWN_SCHEMAS, SchemaEncoder } from '@attestra/sdk';

/**
 * The whole path a person takes, on testnet with nothing mocked: a passkey created in Chrome's
 * virtual authenticator (with PRF, like Face ID or Touch ID) becomes a NEAR implicit account, which
 * issues a membership with no NEAR of its own through the relayer, and the explorer shows it.
 * Run with `pnpm e2e:live` while the stack runs against testnet.
 */
test('a passkey account issues a gasless attestation that the explorer shows', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });

  await page.goto('/sandbox/app/gasless');
  await page.getByRole('button', { name: 'Sign in' }).first().click();
  await page.getByRole('button', { name: 'New here? Create a passkey account' }).click();
  // The header shows the implicit account (64 hex characters, shortened).
  await expect(page.getByRole('banner').getByText(/^[0-9a-f]{4,}.*[0-9a-f]{4}$/)).toBeVisible();

  const member = `member-${Date.now().toString(36)}.testnet`;
  await page.getByLabel('Member').fill(member);
  await page.getByRole('button', { name: 'Sign and relay' }).click();
  await expect(page.getByText('The relayer paid.')).toBeVisible();
  const uid = (await page.locator('code').filter({ hasText: /^[0-9a-f]{64}$/ }).first().textContent())!.trim();

  // The chain has it, issued by the passkey account and decoding to what was typed.
  const att = await new AttestraClient({ network: 'testnet' }).getAttestation(uid);
  expect(att.success).toBe(true);
  expect(att.data?.subject).toBe(member);
  expect(att.data?.attester).toMatch(/^[0-9a-f]{64}$/);
  expect(new SchemaEncoder(KNOWN_SCHEMAS.membership.definition).decode(att.data!.data).organization).toBe('Attestra community');

  await page.getByRole('link', { name: 'Open in the explorer' }).click();
  await expect(page).toHaveURL(new RegExp(`/attestations/${uid}$`));
  await expect(page.getByText(member).first()).toBeVisible();
});

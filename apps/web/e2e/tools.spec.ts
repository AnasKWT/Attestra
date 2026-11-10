/** Sandbox tools that work with no deployment: encoding, UIDs, and the messages forms show for bad input. */

import { computeSchemaUid, contractIdsFor, knownSchemaUid, SchemaEncoder } from '@attestra/sdk';
import { expect, test } from './support';

const RESOLVERS = contractIdsFor('attestra.testnet').resolvers;

test.describe('schema encoder', () => {
  const definition = 'string name, u8 level, bool verified, string[] tags';
  const values = { name: 'Ada Lovelace', level: 7, verified: false, tags: ['math', 'engines'] };

  test('encodes values like the SDK and decodes them back', async ({ page }) => {
    await page.goto('/sandbox/app/schema-encoder');
    await expect(page.locator('#def')).toHaveValue(definition);
    await page.locator('#f-name').fill(values.name);
    await page.locator('#f-level').fill(String(values.level));
    await page.locator('#f-verified').selectOption('false');
    await page.locator('#f-tags').fill(values.tags.join(', '));
    const encoded = new SchemaEncoder(definition).encode(values);
    await expect(page.getByText(encoded, { exact: true })).toBeVisible();

    await page.getByRole('textbox', { name: 'Base64 data' }).fill(encoded);
    const decoded = page.locator('pre').filter({ hasText: values.name });
    await expect(decoded).toBeVisible();
    expect(JSON.parse(await decoded.innerText())).toEqual(values);
  });

  test('decodes data from another definition once the definition matches', async ({ page }) => {
    const def = 'account_id subject, u64 score, bytes32 ref';
    const data = { subject: 'alice.testnet', score: '18446744073709551615', ref: 'ab'.repeat(32) };
    const encoded = new SchemaEncoder(def).encode(data);
    await page.goto('/sandbox/app/schema-encoder');
    await page.locator('#def').fill(def);
    await page.getByRole('textbox', { name: 'Base64 data' }).fill(encoded);
    const decoded = page.locator('pre').filter({ hasText: 'alice.testnet' });
    expect(JSON.parse(await decoded.innerText())).toEqual(new SchemaEncoder(def).decode(encoded));
  });

  test('explains a bad definition, a value out of range and undecodable data', async ({ page }) => {
    await page.goto('/sandbox/app/schema-encoder');
    const def = page.locator('#def');
    const hint = page.locator('label[for="def"]');
    await expect(hint).toContainText('valid');

    await def.fill('strng name');
    await expect(hint).toContainText('unknown type "strng" for field "name"');
    await expect(page.locator('#f-name')).toHaveCount(0);
    await def.fill('string name, u8 name');
    await expect(hint).toContainText('duplicate field name "name"');

    await def.fill('u8 level');
    await page.locator('#f-level').fill('300');
    await expect(page.getByText('value 300 does not fit in u8')).toBeVisible();
    await page.locator('#f-level').fill('255');
    await expect(page.getByText(new SchemaEncoder('u8 level').encode({ level: 255 }), { exact: true })).toBeVisible();

    await def.fill('string name');
    await page.getByRole('textbox', { name: 'Base64 data' }).fill('AQ==');
    await expect(page.getByText(/^Cannot decode: /)).toBeVisible();
  });
});

test.describe('schema builder', () => {
  test('shows the UID the SDK computes, for every change', async ({ page }) => {
    await page.goto('/sandbox/app/schema-builder');
    const uidOf = (def: string, resolver: string | null, revocable: boolean) => page.getByText(computeSchemaUid(def, resolver, revocable), { exact: true });
    let def = 'string name, u8 level, bool verified';
    await expect(page.getByText(def, { exact: true })).toBeVisible();
    await expect(uidOf(def, null, true)).toBeVisible();

    await page.getByText('Attestations can be revoked').click();
    await expect(uidOf(def, null, false)).toBeVisible();

    await page.locator('#resolver').selectOption({ label: 'Whitelist' });
    await expect(uidOf(def, RESOLVERS.whitelist, false)).toBeVisible();
    await page.locator('#resolver').selectOption({ label: 'Pipeline' });
    await expect(uidOf(def, RESOLVERS.pipeline, false)).toBeVisible();

    await page.getByRole('button', { name: 'Add field' }).click();
    await page.getByRole('textbox', { name: 'Field name' }).last().fill('tags');
    await page.getByRole('checkbox', { name: 'list' }).last().check();
    def = 'string name, u8 level, bool verified, string[] tags';
    await expect(page.getByText(def, { exact: true })).toBeVisible();
    await expect(uidOf(def, RESOLVERS.pipeline, false)).toBeVisible();

    await page.getByRole('combobox', { name: 'Type' }).first().selectOption('account_id');
    def = 'account_id name, u8 level, bool verified, string[] tags';
    await expect(uidOf(def, RESOLVERS.pipeline, false)).toBeVisible();
  });

  test('field names keep only valid characters and an empty schema cannot be registered', async ({ page }) => {
    await page.goto('/sandbox/app/schema-builder');
    await page.getByRole('textbox', { name: 'Field name' }).first().fill('full name!');
    await expect(page.getByRole('textbox', { name: 'Field name' }).first()).toHaveValue('fullname');
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Remove field' }).first().click();
    await expect(page.getByText('add a field', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Register schema' })).toBeDisabled();
  });
});

test.describe('create attestation', () => {
  test('checks the schema UID and reports a schema that is not on chain', async ({ page }) => {
    await page.goto('/sandbox/app/create-attestation');
    const hint = page.locator('label[for="schema"]');
    const attest = page.getByRole('button', { name: 'Attest' });
    await expect(attest).toBeDisabled();

    await page.locator('#schema').fill('abc123');
    await expect(hint).toContainText('a UID is 64 hex characters');

    await page.getByRole('combobox', { name: 'Well-known schemas' }).selectOption({ label: 'Membership' });
    await expect(page.locator('#schema')).toHaveValue(knownSchemaUid('membership'));
    await expect(hint).toContainText('not found on chain');

    await page.locator('#subject').fill('bob.testnet');
    await expect(attest).toBeDisabled();
  });

  test('takes the schema from the link', async ({ page }) => {
    const uid = knownSchemaUid('walletLink');
    await page.goto(`/sandbox/app/create-attestation?schema=${uid}`);
    await expect(page.locator('#schema')).toHaveValue(uid);
    await expect(page.locator('label[for="schema"]')).toContainText('not found on chain');
  });
});

test('a write tool asks to sign in when submitted signed out', async ({ page }) => {
  await page.goto('/sandbox/app/revoke');
  await expect(page.getByText('Sign in with a NEAR wallet or a passkey to send transactions.')).toBeVisible();
  const revoke = page.getByRole('button', { name: 'Revoke' });
  await expect(revoke).toBeDisabled();
  await page.locator('#uid').fill('ab'.repeat(32));
  await revoke.click();
  await expect(page.getByText('sign in with a NEAR wallet or a passkey first')).toBeVisible();
});

test('lookup says the contracts are not deployed when the network has none', async ({ page }) => {
  await page.goto('/sandbox/app/lookup');
  await page.locator('#uid').fill('cd'.repeat(32));
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText(/attestations\.attestra\.testnet is not deployed on this network yet/)).toBeVisible();
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { AttestraClient, IndexerClient, KNOWN_SCHEMAS, NETWORKS, SchemaEncoder, knownSchemaUid } from 'attestra';
import { InMemoryKeyStore, Near } from 'near-kit';
import { FileKeyStore } from 'near-kit/keys/file';
import { shortAccount } from '../src/lib/format';
import { PRF_SALT, accountFromSeed, type PasskeyAccount } from '../src/lib/passkey';

/**
 * The browser column of the test matrix, on testnet with nothing mocked. One passkey, created in
 * Chrome's virtual authenticator (with PRF, like Face ID or Touch ID), becomes a NEAR implicit
 * account and carries the whole run: every sandbox tool sends its real transaction, and each test
 * checks what the page shows and, where cheap, reads the chain back through attestra.
 *
 * Many tools send direct transactions, so beforeAll funds the passkey account once from the testnet
 * root (1 NEAR, the root key read from ~/.near-credentials) and afterAll withdraws its storage
 * balances and deletes it with the root as beneficiary, so what is left comes back.
 * Run with `pnpm e2e:live` while the stack (site, indexer, relayer, agent, keeper) runs against testnet.
 * The transaction hashes of the run are written to test-results/live-run.json.
 */

const BASE = process.env.E2E_LIVE ?? 'http://localhost:3100';
const INDEXER = process.env.E2E_INDEXER ?? 'http://localhost:5100';
const AGENT = process.env.E2E_AGENT ?? 'http://localhost:5300';
const ROOT = 'attestra.testnet';
/**
 * Most of it comes back in afterAll. Calls the SDK sends with 300 Tgas need about 0.3 NEAR of
 * liquid balance before they run (the gas is prepaid at the pessimistic price), and storage
 * deposits lock some, so 0.6 NEAR ran dry by the staking test.
 */
const FUND = '1 NEAR';
/**
 * The test's own reads and root transactions go to another RPC than the browser's first one, so the
 * run does not spend the page's rate limit (FastNEAR answers 429 when one IP sends too much).
 */
const RPC = process.env.E2E_RPC ?? NETWORKS.testnet.rpcUrls[1];
/** Unique per run: schema UIDs are global, so every definition carries the run tag. */
const TAG = Date.now().toString(36);
const RUN_FIELD = `run_${TAG}`;
const EVIDENCE = 'State ID card. Name: Test Person. Date of birth: 1990-04-12.';

const reader = new AttestraClient({ network: 'testnet', rpcUrl: RPC, indexerUrl: INDEXER, agentUrl: AGENT });
const indexer = new IndexerClient(INDEXER);
const rootNear = new Near({ network: 'testnet', rpcUrl: RPC, keyStore: new FileKeyStore(join(homedir(), '.near-credentials'), 'testnet') });
const rootClient = new AttestraClient({ network: 'testnet', rpcUrl: RPC, accountId: ROOT, near: rootNear });

let page: Page;
let me: PasskeyAccount;
let funded = false;
/** What the run created, for the later tests and for the report. */
const run: { account?: string; schemaUid?: string; attestationUid?: string; tx: Record<string, string> } = { tx: {} };

const hexUid = /^[0-9a-f]{64}$/;

/** Retries a call from this process that the RPC refused with a 429 before anything was sent. */
async function unthrottled<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 6 || !/\b429\b|Too Many Requests/i.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
}

// ──────────────────────────────────────────────────────────── page helpers

/** Signs in with the passkey this run created (a full page load forgets the session, like a reload). */
async function signIn() {
  const banner = page.getByRole('banner');
  await expect(async () => {
    await banner.getByRole('button', { name: 'Sign in' }).first().click();
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole('menu').getByRole('button', { name: /^Passkey/ }).click();
  await expect(banner.getByText(shortAccount(me.accountId))).toBeVisible();
}

async function open(path: string, opts: { signIn?: boolean } = { signIn: true }) {
  await page.goto(path);
  if (opts.signIn !== false) await signIn();
}

const form = (title: string): Locator => page.getByRole('form', { name: title, exact: true });

/** The transaction link of a result panel, as a hash. */
async function txOf(scope: Locator): Promise<string | undefined> {
  const link = scope.getByRole('status').locator('a[href*="/txns/"]').first();
  if ((await link.count()) === 0) return undefined;
  return (await link.getAttribute('href'))!.split('/txns/')[1];
}

/** Submits an ActionCard and waits for its result; fails with the page's own error text. */
async function submit(title: string, label: string, opts: { expectError?: boolean; timeout?: number } = {}): Promise<{ card: Locator; tx?: string; text: string }> {
  const card = form(title);
  // The result panel; a card's busy note is a status line too, so it is told apart by its element.
  const ok = card.locator('div[role="status"]');
  const bad = card.getByRole('alert');
  // The public RPC rate-limits this IP now and then (other projects share it): a 429, or in the browser a
  // response without CORS headers ("Not reachable"), so try again. Every flow here tolerates a repeat.
  for (let attempt = 1; ; attempt++) {
    await card.getByRole('button', { name: label, exact: true }).click();
    await expect(ok.or(bad).first()).toBeVisible({ timeout: opts.timeout ?? 120_000 });
    if (attempt === 4 || !(await bad.isVisible()) || !/\b429\b|Too Many Requests|Not reachable from this browser/i.test(await bad.innerText())) break;
    await page.waitForTimeout(attempt * 10_000);
  }
  if (opts.expectError) {
    await expect(bad).toBeVisible();
    return { card, text: await bad.innerText() };
  }
  if (await bad.isVisible()) throw new Error(`${title}: ${await bad.innerText()}`);
  return { card, tx: await txOf(card), text: await ok.innerText() };
}

/** The 64-hex UID a UidResult shows. */
async function uidIn(scope: Locator): Promise<string> {
  const code = scope.locator('code').filter({ hasText: hexUid }).first();
  await expect(code).toBeVisible();
  return (await code.textContent())!.trim();
}

/** Registers a schema in the Schema Deployer: the default fields plus this run's tag field. */
async function registerSchema(resolver: string, extraField = RUN_FIELD): Promise<{ uid: string; tx?: string }> {
  await open('/sandbox/app/schema-builder');
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByRole('textbox', { name: 'Field name' }).last().fill(extraField);
  await page.locator('#resolver').selectOption({ label: resolver });
  const expected = (await form('Fields').locator('p.font-mono.text-accent').textContent())?.trim();
  const r = await submit('Fields', 'Register schema');
  const uid = await uidIn(r.card);
  if (expected) expect(uid).toBe(expected);
  return { uid, tx: r.tx };
}

/** Issues an attestation in Create Attestation under a schema registered by registerSchema. */
async function attest(schemaUid: string, subject: string, name: string, opts: { expectError?: boolean; field?: string } = {}) {
  await open(`/sandbox/app/create-attestation?schema=${schemaUid}`);
  await expect(page.locator('#f-name')).toBeVisible();
  await page.locator('#subject').fill(subject);
  await page.locator('#f-name').fill(name);
  await page.locator('#f-level').fill('3');
  await page.locator(`#f-${opts.field ?? RUN_FIELD}`).fill(TAG);
  const r = await submit('Attestation', 'Attest', { expectError: opts.expectError });
  return { ...r, uid: opts.expectError ? '' : await uidIn(r.card) };
}

/** Re-runs a check until it passes: the indexer and the chain's final views trail a fresh transaction. */
async function eventually(fn: () => Promise<void>, timeout = 120_000) {
  await expect(fn).toPass({ timeout, intervals: [2000, 4000, 8000] });
}

// ──────────────────────────────────────────────────────────── passkey key, funding, cleanup

/** Asks the authenticator for the PRF output again (as passkey.ts does) to hold the account key in this process. */
/** A recent finalized devnet transaction of the associated token account program, which always makes inner calls. */
async function solanaInstruction(): Promise<{ signature: string; index: number }> {
  const call = async <T>(method: string, params: unknown[]): Promise<T> =>
    ((await (await fetch('https://api.devnet.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: T }).result;
  const sigs = await call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', { limit: 20, commitment: 'finalized' }]);
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await call<{ meta?: { innerInstructions?: Array<{ index: number; instructions: unknown[] }> } } | null>('getTransaction', [s.signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }]);
    const g = tx?.meta?.innerInstructions?.[0];
    if (g?.instructions?.length) return { signature: s.signature, index: g.index };
  }
  throw new Error('no finalized devnet transaction with inner instructions found');
}

async function derivePasskey(): Promise<PasskeyAccount> {
  const { id, prf } = await page.evaluate(async (salt) => {
    const id = localStorage.getItem('attestra.passkey');
    if (!id) throw new Error('no passkey stored');
    const raw = Uint8Array.from(atob(id.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: raw }],
        extensions: { prf: { eval: { first: new TextEncoder().encode(salt) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
    const first = (cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
    if (!first) throw new Error('no PRF output');
    return { id, prf: Array.from(new Uint8Array(first)) };
  }, PRF_SALT);
  return accountFromSeed(Uint8Array.from(prf).slice(0, 32), id);
}

function passkeyNear(): Near {
  return new Near({ network: 'testnet', rpcUrl: RPC, keyStore: new InMemoryKeyStore({ [me.accountId]: me.secretKey }) });
}

/** Finds a Base Sepolia log at least 40 minutes old and at or below the finalized head, with small data. */
async function baseSepoliaLog(): Promise<{ tx: string; logIndex: number }> {
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetch('https://sepolia.base.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return ((await res.json()) as { result: T }).result;
  };
  type Block = { number: string; timestamp: string; transactions: string[] };
  const fin = await call<Block>('eth_getBlockByNumber', ['finalized', false]);
  const latest = await call<Block>('eth_getBlockByNumber', ['latest', false]);
  const n = (b: Block) => parseInt(b.number, 16);
  const ts = (b: Block) => parseInt(b.timestamp, 16);
  const secsPerBlock = (ts(latest) - ts(fin)) / Math.max(1, n(latest) - n(fin)) || 2;
  const cutoff = Date.now() / 1000 - 45 * 60;
  // Jump back to about 45 minutes ago (or the finalized head if that is older), with a little spread so runs differ.
  let height = Math.min(n(fin), n(latest) - Math.ceil((ts(latest) - cutoff) / secsPerBlock)) - Math.floor(Math.random() * 200);
  for (let tries = 0; tries < 30; tries++, height -= 7) {
    const b = await call<Block>('eth_getBlockByNumber', [`0x${height.toString(16)}`, false]);
    if (!b || ts(b) > cutoff) continue;
    for (const tx of b.transactions.slice(1, 12)) {
      const rc = await call<{ status: string; logs: Array<{ logIndex: string; data: string; topics: string[] }> }>('eth_getTransactionReceipt', [tx]);
      const log = rc?.status === '0x1' ? rc.logs.find((l) => l.data.length <= 66 && l.topics.length >= 1) : undefined;
      if (log) return { tx, logIndex: parseInt(log.logIndex, 16) };
    }
  }
  throw new Error('no suitable Base Sepolia log found');
}

test.describe.configure({ mode: 'serial' });

test.describe('live on testnet with one passkey account', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({ baseURL: BASE });
    page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
    });

    await page.goto('/sandbox/app/gasless');
    await expect(async () => {
      await page.getByRole('banner').getByRole('button', { name: 'Sign in' }).first().click();
      await expect(page.getByRole('menu')).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await page.getByRole('button', { name: 'New here? Create a passkey account' }).click();
    // The header shows the implicit account (64 hex characters, shortened).
    await expect(page.getByRole('banner').getByText(/^[0-9a-f]{6}\.\.\.[0-9a-f]{6}$/)).toBeVisible();
    me = await derivePasskey();
    run.account = me.accountId;
    await expect(page.getByRole('banner').getByText(shortAccount(me.accountId))).toBeVisible();

    // The root funds one account per run; refuse before spending when it is close to empty.
    const root = await unthrottled(() => reader.rpc<{ amount: string }>('query', { request_type: 'view_account', finality: 'optimistic', account_id: ROOT }));
    expect(BigInt(root.amount), `${ROOT} needs at least 1.5 NEAR to fund the run`).toBeGreaterThan(15n * 10n ** 23n);
    const sent = await unthrottled(() => rootNear.transaction(ROOT).transfer(me.accountId, FUND).send());
    funded = true;
    run.tx.fund = (sent as { transaction: { hash: string } }).transaction.hash;
    await eventually(async () => {
      const acct = await reader.rpc<{ amount: string }>('query', { request_type: 'view_account', finality: 'optimistic', account_id: me.accountId });
      expect(BigInt(acct.amount)).toBeGreaterThanOrEqual(10n ** 24n);
    }, 60_000);
  });

  test.afterAll(async () => {
    const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'live-run.json');
    try {
      if (funded && me) {
        const client = new AttestraClient({ network: 'testnet', rpcUrl: RPC, accountId: me.accountId, privateKey: me.secretKey });
        for (const c of ['schemas', 'attestations'] as const) {
          const w = await client.storageWithdraw(c);
          if (w.txHash) run.tx[`withdraw_${c}`] = w.txHash;
        }
        const del = await unthrottled(() => passkeyNear().transaction(me.accountId).deleteAccount({ beneficiary: ROOT }).send());
        run.tx.delete = (del as { transaction: { hash: string } }).transaction.hash;
      }
    } finally {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
      await page?.context().close();
    }
  });

  test('a passkey account issues a gasless attestation through the relayer', async () => {
    await open('/sandbox/app/gasless');
    const member = `member-${TAG}.testnet`;
    await page.getByLabel('Member', { exact: true }).fill(member);
    const r = await submit('Issue a membership without gas', 'Sign and relay');
    await expect(r.card.getByText('The relayer paid.')).toBeVisible();
    const uid = await uidIn(r.card);

    // The chain has it, issued by the passkey account and decoding to what was typed.
    const att = await reader.getAttestation(uid);
    expect(att.success).toBe(true);
    expect(att.data?.subject).toBe(member);
    expect(att.data?.attester).toBe(me.accountId);
    expect(new SchemaEncoder(KNOWN_SCHEMAS.membership.definition).decode(att.data!.data).organization).toBe('Attestra community');

    await r.card.getByRole('link', { name: 'Open in the explorer' }).click();
    await expect(page).toHaveURL(new RegExp(`/attestations/${uid}$`));
    await expect(page.getByText(member).first()).toBeVisible();
  });

  test('the Schema Deployer registers a schema and Create Attestation issues under it', async () => {
    const schema = await registerSchema('None');
    run.schemaUid = schema.uid;
    if (schema.tx) run.tx.register_schema = schema.tx;
    const s = await reader.getSchema(schema.uid);
    expect(s.data?.definition).toBe(`string name, u8 level, bool verified, string ${RUN_FIELD}`);
    expect(s.data?.authority).toBe(me.accountId);

    const subject = `holder-${TAG}.testnet`;
    const a = await attest(schema.uid, subject, 'Test Person');
    run.attestationUid = a.uid;
    if (a.tx) run.tx.attest = a.tx;
    const att = await reader.getAttestation(a.uid);
    expect(att.data?.status).toBe('active');
    expect(att.data?.schema_uid).toBe(schema.uid);
    expect(new SchemaEncoder(s.data!.definition).decode(att.data!.data)).toMatchObject({ name: 'Test Person', level: 3, verified: true, [RUN_FIELD]: TAG });

    // The explorer reads the schema and the attestation back.
    await open(`/schemas/${schema.uid}`, { signIn: false });
    await expect(page.getByRole('row', { name: `${RUN_FIELD} string` })).toBeVisible();
    await open(`/attestations/${a.uid}`, { signIn: false });
    await expect(page.getByText(subject).first()).toBeVisible();
    await expect(page.getByText('Test Person').first()).toBeVisible();
  });

  test('a credential mints to the subject and burns when the attestation is revoked', async () => {
    const subject = `credential-${TAG}.testnet`;
    const a = await attest(run.schemaUid!, subject, 'Credential holder');

    await open('/sandbox/app/nft-credential');
    await page.locator('#u').fill(a.uid);
    const mint = await submit('Mint', 'Mint credential');
    if (mint.tx) run.tx.mint_credential = mint.tx;
    const cred = await reader.getCredential(a.uid);
    expect(cred.data?.owner_id).toBe(subject);
    const read = await submit('Credential for an attestation', 'Read');
    expect(read.text).toContain(subject);

    await open('/sandbox/app/revoke');
    await page.locator('#uid').fill(a.uid);
    const rev = await submit('Revoke an attestation', 'Revoke');
    if (rev.tx) run.tx.revoke = rev.tx;
    expect((await reader.getAttestation(a.uid)).data?.status).toBe('revoked');
    // The attestations contract told the credentials contract: the token is gone.
    await eventually(async () => expect((await reader.getCredential(a.uid)).data ?? null).toBeNull(), 60_000);

    await open('/sandbox/app/nft-credential');
    await page.locator('#u').fill(a.uid);
    const after = await submit('Credential for an attestation', 'Read');
    expect(after.text).toContain('null');

    await open(`/attestations/${a.uid}`, { signIn: false });
    await expect(page.getByText('revoked').first()).toBeVisible();
  });

  test('a delegated attestation is signed off chain and submitted by the relayer; an on-chain delegate is added', async () => {
    await open('/sandbox/app/delegated-attestation');
    await page.locator('#schema').fill(run.schemaUid!);
    await expect(page.locator('#f-name')).toBeVisible();
    const subject = `delegated-${TAG}.testnet`;
    await page.locator('#subj').fill(subject);
    await page.locator('#f-name').fill('Signed off chain');
    await page.locator(`#f-${RUN_FIELD}`).fill(TAG);
    await submit('1. Sign a request off chain', 'Sign');
    // A passkey account's key is its account id, so nothing needs registering.
    await expect(page.getByText('This key is not registered as a signer key yet.')).toHaveCount(0);
    const submitPanel = page.getByRole('region', { name: '2. Submit', exact: true });
    await submitPanel.getByRole('button', { name: 'Submit through the relayer' }).click();
    await expect(submitPanel.getByRole('status').or(submitPanel.getByRole('alert')).first()).toBeVisible({ timeout: 120_000 });
    await expect(submitPanel.getByRole('alert')).toHaveCount(0);
    const uid = await uidIn(submitPanel);
    const tx = await txOf(submitPanel);
    if (tx) run.tx.delegated_relayed = tx;
    const att = await reader.getAttestation(uid);
    expect(att.data?.attester).toBe(me.accountId);
    expect(att.data?.subject).toBe(subject);

    const delegate = `assistant-${TAG}.testnet`;
    await page.locator('#del').fill(delegate);
    const d = await submit('On-chain delegate', 'Add delegate');
    if (d.tx) run.tx.add_delegate = d.tx;
    expect((await reader.isDelegate(me.accountId, delegate)).data?.isDelegate).toBe(true);
  });

  test('the whitelist resolver refuses an attester until the schema admin adds them', async () => {
    const field = `wl_${TAG}`;
    const schema = await registerSchema('Whitelist', field);
    expect((await reader.getSchema(schema.uid)).data?.resolver).toBe('whitelist.attestra.testnet');

    const refused = await attest(schema.uid, `wl-${TAG}.testnet`, 'Not yet', { expectError: true, field });
    expect(refused.text).toMatch(/refused/);

    await open('/sandbox/app/whitelist-manager');
    await page.locator('#suid').fill(schema.uid);
    await page.locator('#acc').fill(me.accountId);
    const add = await submit('Manage the list', 'Add to whitelist');
    if (add.tx) run.tx.whitelist_add = add.tx;
    const check = await submit('Check', 'Is it whitelisted?');
    expect(check.text).toMatch(/"whitelisted": true/);

    const ok = await attest(schema.uid, `wl-${TAG}.testnet`, 'Now allowed', { field });
    if (ok.tx) run.tx.whitelist_attest = ok.tx;
    expect((await reader.getAttestation(ok.uid)).data?.status).toBe('active');
  });

  test('a scheduled revocation takes effect at its time and the keeper records it', async () => {
    test.setTimeout(420_000);
    const a = await attest(run.schemaUid!, `scheduled-${TAG}.testnet`, 'Expires soon');
    await open('/sandbox/app/scheduled-revocation');
    await page.locator('#u').fill(a.uid);
    await page.locator('#m').fill('1');
    const s = await submit('Schedule', 'Schedule revocation');
    if (s.tx) run.tx.schedule_revocation = s.tx;
    const before = await reader.getAttestation(a.uid);
    expect(before.data?.revoke_at).toBeGreaterThan(0);
    expect(before.data?.status).toBe('active');

    // No transaction is needed for it to take effect: reads after the time report it revoked.
    await eventually(async () => expect((await reader.getAttestation(a.uid)).data?.status).toBe('revoked'), 150_000);
    // A fresh load: the dev server may have reloaded the page during the wait.
    await open('/sandbox/app/scheduled-revocation', { signIn: false });
    await page.locator('#u').fill(a.uid);
    const status = await submit('Status', 'Check');
    expect(status.text).toMatch(/"due": true/);

    // The keeper then calls finalize_revocation, which writes the revocation event the indexer sees.
    await eventually(async () => {
      const ev = await indexer.listEvents({ uid: a.uid, event: 'attestation_revoked', limit: 1 });
      expect(ev.data.length).toBe(1);
      run.tx.keeper_finalize = ev.data[0].tx_hash;
    }, 180_000);
  });

  test('a 2-of-2 multisig authority attests once both members approved', async () => {
    await open('/sandbox/app/multisig-authority');
    await page.locator('#mem').fill(`${me.accountId}, ${ROOT}`);
    await page.locator('#k').fill('2');
    await page.locator('#meta').fill(`Live committee ${TAG}`);
    const c = await submit('Create', 'Create multisig');
    if (c.tx) run.tx.multisig_create = c.tx;
    const msId = (await page.locator('#ms').inputValue()).trim();
    expect(msId).toMatch(/^ms-\d+\./);

    await page.locator('#schema').fill(run.schemaUid!);
    await expect(page.locator('#f-name')).toBeVisible();
    const subject = `multisig-${TAG}.testnet`;
    await page.locator('#sub').fill(subject);
    await page.locator('#f-name').fill('Committee decision');
    await page.locator(`#f-${RUN_FIELD}`).fill(TAG);
    const p = await submit('Propose an attestation', 'Propose');
    if (p.tx) run.tx.multisig_propose = p.tx;
    const pid = Number(await page.locator('#pid').inputValue());
    expect((await reader.getProposal(pid)).data?.status).toMatch(/open/i);

    // The second member (the testnet root) approves from its own key, which executes the proposal.
    const approved = await unthrottled(async () => {
      const r = await rootClient.approveMultisig(pid);
      if (!r.success && /\b429\b|Too Many Requests/i.test(r.error?.message ?? '')) throw new Error(r.error!.message);
      return r;
    });
    expect(approved.success, approved.error?.message).toBe(true);
    if (approved.txHash) run.tx.multisig_approve = approved.txHash;
    expect(approved.data?.status).toBe('created');
    // This process reads through another RPC than the one that sent the approval; it can trail by a block or throttle.
    await eventually(async () => {
      const att = await reader.getAttestation(approved.data!.uid);
      expect(att.data?.attester, att.error?.message).toBe(msId);
      expect(att.data?.subject).toBe(subject);
    }, 60_000);

    const read = await submit('Read', 'Read proposal and multisig');
    expect(read.text).toMatch(/executed/i);
  });

  test('a Sputnik DAO issues a membership attestation once its council approves', async () => {
    const DAO = 'attestra.sputnik-v2.testnet';
    await open('/sandbox/app/dao-attestation');
    await expect(page.getByText('keeper.attestra.testnet').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('#role').selectOption('contributor');
    const p = await submit('Ask for membership', 'Submit proposal');
    if (p.tx) run.tx.dao_propose = p.tx;
    const pid = Number(await page.locator('#pid').inputValue());
    expect(Number.isInteger(pid)).toBe(true);

    // The keeper, a council member, checks the request against the DAO's rule and votes; the DAO attests in that transaction.
    const review = await submit('Council review', 'Ask the council', { timeout: 180_000 });
    if (review.tx) run.tx.dao_approve = review.tx;
    expect(review.text).toMatch(/Approved/);
    const href = await review.card.getByRole('status').locator('a[href^="/attestations/"]').first().getAttribute('href');
    const uid = href!.split('/attestations/')[1];
    await eventually(async () => {
      const att = await reader.getAttestation(uid);
      expect(att.data?.attester, att.error?.message).toBe(DAO);
      expect(att.data?.subject).toBe(me.accountId);
      expect(new SchemaEncoder(KNOWN_SCHEMAS.membership.definition).decode(att.data!.data)).toMatchObject({ organization: DAO, role: 'contributor' });
      expect((await reader.getDaoProposal(DAO, pid)).data?.status).toBe('Approved');
    }, 60_000);

    // The explorer names the DAO as the attester and shows the vote that issued it.
    await open(`/attestations/${uid}`, { signIn: false });
    await expect(page.getByText('Sputnik DAO').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`#${pid}`, { exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test('staking test tokens earns a tier that shows on the authority record', async () => {
    await open('/sandbox/app/register-authority');
    await page.locator('#meta').fill(`Live test issuer ${TAG}`);
    const reg = await submit('Register or update', 'Register');
    if (reg.tx) run.tx.register_authority = reg.tx;

    await open('/sandbox/app/token-staking');
    await expect(page.getByText('Bronze').first()).toBeVisible();
    const f = await submit('Faucet', 'Get 1,000 tATT');
    if (f.tx) run.tx.faucet = f.tx;
    await page.locator('#a').fill('100');
    const st = await submit('Stake', 'Stake');
    if (st.tx) run.tx.stake = st.tx;
    expect((await reader.getStake(me.accountId)).data?.tier).toBe('Bronze');
    const mine = await submit('My stake', 'Read');
    expect(mine.text).toMatch(/"tier": "Bronze"/);
    expect(mine.text).toMatch(/"tier_on_authority_record": "Bronze"/);

    await open(`/authorities/${me.accountId}`, { signIn: false });
    await eventually(async () => {
      await page.reload();
      await expect(page.getByText(`Live test issuer ${TAG}`).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('Bronze').first()).toBeVisible({ timeout: 5000 });
    });
  });

  test('a large schema is stored as a blob and registered by its hash', async () => {
    await open('/sandbox/app/file-schema');
    const textarea = page.locator('#d');
    const definition = `${await textarea.inputValue()}, string ${RUN_FIELD}`;
    await textarea.fill(definition);
    const blob = await submit('1. Store the definition', 'Store blob');
    if (blob.tx) run.tx.store_blob = blob.tx;
    const reg = await submit('2. Register from the blob', 'Register schema');
    if (reg.tx) run.tx.register_blob_schema = reg.tx;
    const uid = await uidIn(reg.card);
    const s = await reader.getSchema(uid);
    expect(s.data?.definition).toBe(definition);
    expect(s.data?.blob_hash).toMatch(hexUid);

    await open(`/schemas/${uid}`, { signIn: false });
    await expect(page.getByText('Stored as an on-chain blob (large schema)')).toBeVisible();
  });

  test('a light client proof of the attestation verifies in the browser', async () => {
    await open('/sandbox/app/verify-proof', { signIn: false });
    await page.locator('#u').fill(run.attestationUid!);
    await page.getByRole('button', { name: 'Load' }).click();
    await eventually(async () => {
      await page.getByRole('button', { name: 'Prove it' }).click();
      await expect(page.getByText(/^Final: the event is in block [\d,]+, an ancestor of the approved head [\d,]+\.$/)).toBeVisible({ timeout: 30_000 });
    }, 180_000);
  });

  test('a private AI check attests a pass with only the evidence hash', async () => {
    // A busy OutLayer queue can drop a run; the agent sends it again, up to three runs.
    test.setTimeout(720_000);
    await open('/sandbox/app/private-check');
    const health = (await (await fetch(`${AGENT}/health`)).json()) as { checker: { mode: 'local' | 'outlayer' } };
    await expect(page.getByText(health.checker.mode === 'outlayer' ? 'Live: OutLayer TEE' : 'Live: local mode (bootstrap key)')).toBeVisible();
    await page.locator('#rule').selectOption('age_over_18');
    await page.locator('#sub').fill(me.accountId);
    await page.locator('#ev').fill(EVIDENCE);
    const r = await submit('Check a private fact', 'Encrypt and check', { timeout: 660_000 });
    if (r.tx) run.tx.private_check = r.tx;
    const uid = await uidIn(r.card);
    const att = await reader.getAttestation(uid);
    expect(att.data?.schema_uid).toBe(knownSchemaUid('aiCheck'));
    expect(att.data?.subject).toBe(me.accountId);
    const fields = new SchemaEncoder(KNOWN_SCHEMAS.aiCheck.definition).decode(att.data!.data);
    expect(fields).toMatchObject({ rule_id: 'age_over_18', result: true });
    // Only the hash of the evidence is on chain, never the text.
    expect(JSON.stringify(fields)).not.toContain('Test Person');
  });

  test('a fact from Base Sepolia is verified by the MPC network and attested', async () => {
    test.setTimeout(600_000);
    const { tx, logIndex } = await baseSepoliaLog();
    run.tx.base_sepolia_source = tx;
    await open('/sandbox/app/cross-chain');
    await page.locator('#ch').selectOption('base');
    await page.locator('#tx').fill(tx);
    await page.locator('#li').fill(String(logIndex));
    await submit('1. Read the event on its chain', 'Fetch the log');
    const r = await submit('2. Verify with Chain Signatures and attest', 'Verify and attest', { timeout: 420_000 });
    if (r.tx) run.tx.cross_chain = r.tx;
    const uid = await uidIn(r.card);
    const att = await reader.getAttestation(uid);
    expect(att.data?.schema_uid).toBe(knownSchemaUid('foreignEvent'));
    const fields = new SchemaEncoder(KNOWN_SCHEMAS.foreignEvent.definition).decode(att.data!.data);
    expect(fields).toMatchObject({ chain: 'base', log_index: String(logIndex) });
  });

  test('a Solana instruction is verified by the MPC network and attested', async () => {
    test.setTimeout(600_000);
    const { signature, index } = await solanaInstruction();
    run.tx.solana_source = signature;
    await open('/sandbox/app/cross-chain');
    await page.locator('#ch').selectOption('solana');
    await page.locator('#tx').fill(signature);
    await page.locator('#li').fill(String(index));
    await page.locator('#ii').fill('0');
    await submit('1. Read the event on its chain', 'Fetch the instruction');
    const r = await submit('2. Verify with Chain Signatures and attest', 'Verify and attest', { timeout: 420_000 });
    if (r.tx) run.tx.solana = r.tx;
    const uid = await uidIn(r.card);
    const att = await reader.getAttestation(uid);
    expect(att.data?.schema_uid).toBe(knownSchemaUid('foreignInstruction'));
    const fields = new SchemaEncoder(KNOWN_SCHEMAS.foreignInstruction.definition).decode(att.data!.data);
    expect(fields).toMatchObject({ chain: 'solana', instruction_index: String(index), inner_instruction_index: '0' });
  });

  test('an agent is registered by its owner and rated by a client, and its profile shows both', async () => {
    const agent = `agent-${TAG}.testnet`;
    await open(`/sandbox/app/agents?agent=${agent}`);
    await page.locator('#n').fill(`Live agent ${TAG}`);
    await page.locator('#e').fill('https://agent.example/a2a');
    const reg = await submit('Owner: register the agent', 'Attest identity');
    if (reg.tx) run.tx.register_agent = reg.tx;
    await page.locator('#sc').selectOption('4');
    await page.locator('#j').fill(`live run ${TAG}`);
    await page.locator('#cm').fill('Answered every check on time.');
    const rate = await submit('Client: review the agent', 'Leave review');
    if (rate.tx) run.tx.rate_agent = rate.tx;
    expect((await reader.getAttestation(await uidIn(rate.card))).data?.schema_uid).toBe(knownSchemaUid('agentReview'));

    await page.getByRole('link', { name: 'Open the agent profile' }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent}$`));
    await eventually(async () => {
      await page.reload();
      await expect(page.getByRole('heading', { name: `Live agent ${TAG}` })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('4.00 from 1')).toBeVisible({ timeout: 5000 });
      await expect(page.getByText('Answered every check on time.')).toBeVisible({ timeout: 5000 });
    });
  });

  test('x402: a claim is verified for a test token payment the agent settles on chain', async () => {
    await open('/sandbox/app/paid-verify');
    await page.locator('#k').selectOption('claim');
    await page.locator('#t').fill(run.attestationUid!);
    const price = await submit('1. See the price', 'Ask for the price');
    expect(price.text).toContain('token.attestra.testnet');
    const before = BigInt((await reader.tokenBalance(me.accountId)).data!.balance);
    const paid = await submit('2. Pay and get the answer', 'Pay and verify', { timeout: 180_000 });
    const settlement = /"transaction": "([1-9A-HJ-NP-Za-km-z]{43,44})"/.exec(paid.text);
    expect(settlement, paid.text).not.toBeNull();
    run.tx.x402_settlement = settlement![1];
    expect(paid.text).toContain(run.attestationUid!);
    await eventually(async () => expect(BigInt((await reader.tokenBalance(me.accountId)).data!.balance)).toBe(before - 10n ** 18n), 60_000);
  });

  test('the agent chat answers from the chain with a signed reply', async () => {
    await open('/sandbox/app/agent-chat', { signIn: false });
    await page.getByRole('textbox', { name: 'Message' }).fill(`Is attestation ${run.attestationUid} still valid? Answer in one sentence.`);
    await page.getByRole('button', { name: 'Send' }).click();
    const signed = page.getByRole('link', { name: /(signature verified|signed) by / });
    await expect(signed).toBeVisible({ timeout: 180_000 });
    await expect(page.getByText(/valid|active/i).last()).toBeVisible();
  });

  test('the explorer lists what this account created', async () => {
    await open(`/accounts/${me.accountId}`, { signIn: false });
    await eventually(async () => {
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Registered authority' })).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(`a[href="/attestations/${run.attestationUid}"]`).first()).toBeVisible({ timeout: 5000 });
    });
    // The run issued four attestations under its schema (two revoked, one by schedule, one by the multisig).
    await open(`/schemas/${run.schemaUid}`, { signIn: false });
    await eventually(async () => {
      await page.reload();
      const count = page.locator('dt', { hasText: /^Attestations$/ }).locator('xpath=following-sibling::dd[1]');
      await expect(count).toHaveText(/^[1-9]\d*$/, { timeout: 10_000 });
      expect(Number(await count.textContent())).toBeGreaterThanOrEqual(4);
    }, 60_000);
    await open('/audit-log', { signIn: false });
    await expect(page.getByRole('heading', { name: /Audit log/i })).toBeVisible();
  });
});

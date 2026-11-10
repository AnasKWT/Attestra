/**
 * The relayer's HTTP API: gasless NEP-413 submissions, NEP-366 meta transactions and sponsored
 * storage deposits. Every route checks everything it can off chain before spending gas.
 */

import { errorMessage, type StorageBalance } from '@attestra/sdk';
import { bodyLimit } from 'hono/body-limit';
import { isValidAccountId } from 'near-kit';
import type { ChainReader, ChainWriter } from '../lib/chain';
import { withTimeout } from '../lib/chain';
import { baseApp, jsonBody, type HealthReport } from '../lib/http';
import type { Logger, RecentErrors } from '../lib/log';
import { TGAS, formatNear } from '../lib/units';
import type { RelayerConfig } from './config';
import { checkMeta, metaReceivers } from './meta';
import { RelayerPolicy, SPONSOR_AMOUNT, checkSignedRequest, isImplicitOf, storageTopUp } from './policy';

export interface RelayerDeps {
  config: RelayerConfig;
  reader: ChainReader;
  /** null in idle mode (no key). */
  writer: ChainWriter | null;
  policy: RelayerPolicy;
  log: Logger;
  errors: RecentErrors;
  nowSecs?: () => number;
}

const SUBMIT_GAS = 300n * TGAS;
const STORAGE_GAS = 30n * TGAS;
const BALANCE_TTL_MS = 15_000;

export function createRelayerApp(deps: RelayerDeps) {
  const { config, reader, writer, policy, log, errors } = deps;
  const now = deps.nowSecs ?? (() => Math.floor(Date.now() / 1000));
  const attestations = config.net.contracts.attestations;
  const receivers = metaReceivers(config.net);
  let balanceCache: { at: number; value: bigint | null; error?: string } | null = null;

  async function balance() {
    if (balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache;
    try {
      balanceCache = { at: Date.now(), value: await withTimeout(reader.balance(config.accountId), 5000, 'balance read') };
    } catch (e) {
      balanceCache = { at: Date.now(), value: null, error: errorMessage(e) };
    }
    return balanceCache;
  }

  async function health(): Promise<HealthReport> {
    const b = await balance();
    const reasons: string[] = [];
    if (!writer) reasons.push(config.idleReason ?? 'idle');
    if (b.error) reasons.push(`balance unreadable: ${b.error}`);
    else if (b.value === null) reasons.push(`${config.accountId} does not exist`);
    else if (b.value < config.lowBalance) reasons.push(`balance below ${formatNear(config.lowBalance)} NEAR`);
    return {
      ok: reasons.length === 0,
      ...(reasons.length ? { reason: reasons.join('; ') } : {}),
      service: 'relayer',
      network: config.network,
      mode: writer ? 'active' : 'idle',
      account: config.accountId,
      balance_near: b.value === null ? null : formatNear(b.value),
      budgets: policy.usage(),
      queue: { length: writer?.queueLength() ?? 0, lanes: writer?.lanes ?? 0 },
      gas_key: writer?.gasKey ?? false,
      allowlist: config.allowlist.size ? [...config.allowlist] : 'open',
      recent_errors: errors.list(),
    };
  }

  const app = baseApp(health);
  app.use('/v1/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'body too large' }, 413) }));

  const idle = () => ({ error: `relayer is idle: ${config.idleReason}` });
  const chainError = (what: string, e: unknown) => {
    const message = errorMessage(e);
    errors.add(`${what}: ${message}`);
    log(`${what} failed: ${message}`);
    const txHash = (e as { txHash?: string })?.txHash;
    return { error: message, ...(txHash ? { tx_hash: txHash } : {}) };
  };

  app.post('/v1/submit', async (c) => {
    if (!writer) return c.json(idle(), 503);
    const body = (await jsonBody(c)) as { request?: unknown } | undefined;
    const checked = checkSignedRequest(body?.request, attestations, now());
    if (!checked.ok) {
      log(`submit refused (${checked.status}): ${checked.error}`);
      return c.json({ error: checked.error }, checked.status);
    }
    const { request, action } = checked.value;
    const attester = action.attester;
    if (!policy.allows(attester)) {
      log(`submit refused (403): ${attester} is not on the allowlist`);
      return c.json({ error: `${attester} is not on the relayer's allowlist` }, 403);
    }

    let keys: string[] = [];
    if (!isImplicitOf(attester, request.public_key)) {
      try {
        keys = (await reader.view<string[]>(attestations, 'get_signer_keys', { account_id: attester })) ?? [];
      } catch (e) {
        return c.json(chainError('reading signer keys', e), 502);
      }
      if (!keys.includes(request.public_key)) {
        log(`submit refused (401): ${request.public_key} is not a signer key of ${attester}`);
        return c.json({ error: `the key is not a signer key of ${attester} (register it with add_signer_key)` }, 401);
      }
    }

    const over = policy.takeSubmission(attester);
    if (over) {
      log(`submit refused (429): ${over}`);
      return c.json({ error: over }, 429);
    }

    let storage: StorageBalance | null = null;
    try {
      storage = await reader.view<StorageBalance | null>(attestations, 'storage_balance_of', { account_id: attester });
    } catch {
      storage = null;
    }
    const deposit = storageTopUp(storage);
    if (deposit > 0n && !policy.takeStorage(deposit)) {
      policy.refundSubmission(attester);
      log(`submit refused (429): storage budget spent, ${attester} needs a storage deposit`);
      return c.json({ error: `${attester} has no storage balance left and the relayer's daily storage budget is spent` }, 429);
    }

    try {
      const r = await writer.call(attestations, 'submit_signed', { request }, { deposit, gas: SUBMIT_GAS });
      const outcome = r.value as { uid?: string; status?: string } | null;
      log(`submit ${action.action} for ${attester}: ${outcome?.status ?? 'no outcome'} ${outcome?.uid ?? ''} tx ${r.txHash}${deposit ? ` (+${formatNear(deposit)} NEAR storage)` : ''}`);
      return c.json({ outcome, tx_hash: r.txHash });
    } catch (e) {
      // A failed call returns its attached deposit; the submission still counts (it cost gas).
      if (deposit > 0n) policy.refundStorage(deposit);
      return c.json(chainError(`submit ${action.action} for ${attester}`, e), 502);
    }
  });

  app.post('/v1/meta', async (c) => {
    if (!writer) return c.json(idle(), 503);
    const body = (await jsonBody(c)) as { signed_delegate?: unknown } | undefined;
    const checked = checkMeta(body?.signed_delegate, receivers);
    if (!checked.ok) {
      log(`meta refused (${checked.status}): ${checked.error}`);
      return c.json({ error: checked.error }, checked.status);
    }
    const { signed, sender, receiver, methods, publicKey } = checked.value;
    try {
      if (!(await reader.hasKey(sender, publicKey))) {
        log(`meta refused (401): ${publicKey} is not an access key of ${sender}`);
        return c.json({ error: `${publicKey} is not an access key of ${sender}` }, 401);
      }
    } catch (e) {
      return c.json(chainError(`reading ${sender}'s access key`, e), 502);
    }
    const over = policy.takeMeta(sender);
    if (over) {
      log(`meta refused (429): ${over}`);
      return c.json({ error: over }, 429);
    }
    try {
      const r = await writer.relay(signed);
      log(`meta ${sender} -> ${receiver}.${methods.join(',')} tx ${r.txHash}`);
      return c.json({ tx_hash: r.txHash, outcome: r.value });
    } catch (e) {
      return c.json(chainError(`meta ${sender} -> ${receiver}`, e), 502);
    }
  });

  app.post('/v1/sponsor-storage', async (c) => {
    if (!writer) return c.json(idle(), 503);
    const body = (await jsonBody(c)) as { account_id?: unknown; contract?: unknown } | undefined;
    const account = body?.account_id;
    const which = body?.contract;
    if (typeof account !== 'string' || !isValidAccountId(account)) return c.json({ error: 'account_id must be a valid account id' }, 400);
    if (which !== 'schemas' && which !== 'attestations') return c.json({ error: 'contract must be "schemas" or "attestations"' }, 400);
    if (!policy.allows(account)) return c.json({ error: `${account} is not on the relayer's allowlist` }, 403);
    const contract = config.net.contracts[which];

    let current: StorageBalance | null = null;
    try {
      current = await reader.view<StorageBalance | null>(contract, 'storage_balance_of', { account_id: account });
    } catch {
      current = null;
    }
    if (storageTopUp(current) === 0n) {
      log(`sponsor-storage skipped: ${account} already holds storage on ${which}`);
      return c.json({ deposited: '0', storage_balance: current, tx_hash: null });
    }
    if (!policy.takeSponsor(account, which)) {
      log(`sponsor-storage refused (429): ${account} was sponsored on ${which} today`);
      return c.json({ error: `${account} was already sponsored on ${which} today` }, 429);
    }
    if (!policy.takeStorage(SPONSOR_AMOUNT)) {
      policy.refundSponsor(account, which);
      log('sponsor-storage refused (429): storage budget spent');
      return c.json({ error: "the relayer's daily storage budget is spent" }, 429);
    }
    try {
      const r = await writer.call(contract, 'storage_deposit', { account_id: account, registration_only: null }, { deposit: SPONSOR_AMOUNT, gas: STORAGE_GAS });
      log(`sponsor-storage ${formatNear(SPONSOR_AMOUNT)} NEAR for ${account} on ${which} tx ${r.txHash}`);
      return c.json({ deposited: SPONSOR_AMOUNT.toString(), storage_balance: r.value, tx_hash: r.txHash });
    } catch (e) {
      policy.refundStorage(SPONSOR_AMOUNT);
      return c.json(chainError(`sponsor-storage for ${account}`, e), 502);
    }
  });

  /**
   * Funds a passkey account so it exists on chain: a passkey derives an ed25519 key whose implicit
   * account (64 hex characters) the transfer creates. Once per account, within the storage budget.
   */
  app.post('/v1/passkey-account', async (c) => {
    if (!writer) return c.json(idle(), 503);
    const body = (await jsonBody(c)) as { account_id?: unknown } | undefined;
    const account = body?.account_id;
    if (typeof account !== 'string' || !/^[0-9a-f]{64}$/.test(account)) return c.json({ error: 'account_id must be an implicit account (64 hex characters)' }, 400);
    if (!policy.allows(account)) return c.json({ error: `${account} is not on the relayer's allowlist` }, 403);
    let exists = false;
    try {
      exists = (await reader.balance(account)) !== null;
    } catch {
      exists = false;
    }
    if (exists) return c.json({ created: false, account_id: account, tx_hash: null });
    if (!policy.takeSponsor(account, 'passkey')) return c.json({ error: `${account} was already funded today` }, 429);
    if (!policy.takeStorage(SPONSOR_AMOUNT)) {
      policy.refundSponsor(account, 'passkey');
      return c.json({ error: "the relayer's daily budget is spent" }, 429);
    }
    try {
      const r = await writer.transfer(account, SPONSOR_AMOUNT);
      log(`passkey-account funded ${account} with ${formatNear(SPONSOR_AMOUNT)} NEAR tx ${r.txHash}`);
      return c.json({ created: true, account_id: account, funded: SPONSOR_AMOUNT.toString(), tx_hash: r.txHash });
    } catch (e) {
      policy.refundStorage(SPONSOR_AMOUNT);
      policy.refundSponsor(account, 'passkey');
      return c.json(chainError(`passkey-account ${account}`, e), 502);
    }
  });

  return app;
}

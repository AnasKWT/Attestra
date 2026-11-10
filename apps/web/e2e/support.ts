/**
 * Shared fixtures: every page runs as if the testnet contracts were not deployed and no Attestra
 * service were running, and every test fails on an uncaught page error, a console error outside
 * the allowlist below, or a request to a host this file does not know.
 */

import { NETWORKS } from '@attestra/sdk';
import { expect, test as base, type Page, type Route } from '@playwright/test';

/** The services the build points at (playwright.config.ts pins these); none of them runs during the suites. */
export const SERVICE_ORIGINS = ['http://localhost:5100', 'http://localhost:5200', 'http://localhost:5300', 'http://localhost:5400', 'http://localhost:5500'];

/** Testnet RPC endpoints: answered here the way NEAR answers views on an account that does not exist. */
const RPC_ORIGINS = [...NETWORKS.testnet.rpcUrls, NETWORKS.testnet.archivalRpcUrl].map((u) => new URL(u).origin);

/** NEAR Connect's wallet list; an empty list keeps the suites offline. */
const WALLET_MANIFESTS = ['https://raw.githubusercontent.com/hot-dao/near-selector/', 'https://cdn.jsdelivr.net/gh/azbang/hot-connector/'];

/**
 * The only console errors a page may log: Chrome reports each refused connection to a service as
 * "Failed to load resource: net::ERR_CONNECTION_REFUSED", with the service URL as its location.
 */
function allowedConsoleError(text: string, url: string): boolean {
  return text === 'Failed to load resource: net::ERR_CONNECTION_REFUSED' && SERVICE_ORIGINS.some((o) => url.startsWith(`${o}/`));
}

interface RpcRequest {
  jsonrpc: string;
  id: unknown;
  method: string;
  params?: { account_id?: string };
}

function rpcAnswer(req: RpcRequest, unexpected: string[]) {
  const account = req.params?.account_id;
  if (req.method === 'query' && account) {
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: {
        name: 'HANDLER_ERROR',
        cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: account, block_hash: '11111111111111111111111111111111', block_height: 1 } },
        code: -32000,
        message: 'Server error',
        data: `account ${account} does not exist while viewing`,
      },
    };
  }
  unexpected.push(`RPC method ${req.method}`);
  return { jsonrpc: '2.0', id: req.id, error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'METHOD_NOT_FOUND', info: {} }, code: -32601, message: 'Method not found' } };
}

export interface Diagnostics {
  /** Page errors, disallowed console errors and requests to unknown hosts, in order. */
  problems: string[];
  /** Allows one more console error for this test (for example the 404 status of a missing page). */
  allow: (pattern: RegExp) => void;
}

async function offline(page: Page, origin: string, problems: string[]) {
  await page.route('**/*', async (route: Route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) || url.startsWith('data:') || url.startsWith('blob:')) return route.fallback();
    if (SERVICE_ORIGINS.some((o) => url.startsWith(`${o}/`))) return route.abort('connectionrefused');
    if (RPC_ORIGINS.some((o) => url === o || url.startsWith(`${o}/`))) {
      const body = route.request().postDataJSON() as RpcRequest | RpcRequest[];
      const answer = Array.isArray(body) ? body.map((b) => rpcAnswer(b, problems)) : rpcAnswer(body, problems);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) });
    }
    if (WALLET_MANIFESTS.some((m) => url.startsWith(m))) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ wallets: [], version: '1.0.0' }) });
    problems.push(`request to an unknown host: ${url}`);
    return route.abort('blockedbyclient');
  });
}

export const test = base.extend<{ diagnostics: Diagnostics }>({
  diagnostics: [
    async ({ page, baseURL }, use) => {
      const problems: string[] = [];
      const extra: RegExp[] = [];
      page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const text = m.text();
        const url = m.location().url ?? '';
        if (allowedConsoleError(text, url) || extra.some((re) => re.test(text))) return;
        problems.push(`console error: ${text}${url ? ` (${url})` : ''}`);
      });
      await offline(page, new URL(baseURL!).origin, problems);
      await use({ problems, allow: (re) => extra.push(re) });
      expect(problems, 'page errors, console errors or unknown requests').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Waits until a page has settled: no loading skeleton is left, so every read has answered or failed visibly. */
export async function settled(page: Page, ready?: string) {
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.locator('.skeleton')).toHaveCount(0);
  if (ready) await expect(page.getByText(ready).first()).toBeVisible();
}

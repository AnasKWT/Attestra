import { existsSync } from 'node:fs';
import { chromium, defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suites for the site, run against a production build (`next build` + `next start`).
 * No chain deployment or service is needed: e2e/support.ts answers the testnet RPC as if the
 * contracts were not deployed and refuses connections to the indexer and the other services.
 *
 *   pnpm e2e          every suite except the screenshot sweep
 *   pnpm e2e:shots    full-page screenshots of every route to .data/shots/
 *   pnpm e2e:live     e2e/live.spec.ts against a running stack on testnet (E2E_LIVE, default
 *                     http://localhost:3100, with the indexer, relayer, agent and keeper up): one real
 *                     passkey, funded with 1 NEAR from the testnet root key in ~/.near-credentials and
 *                     deleted back to the root at the end, drives every sandbox flow on chain
 *
 * E2E_PORT picks another port (default 3100) when something else already serves 3100.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${PORT}`;
const SHOTS = Boolean(process.env.E2E_SHOTS);
const LIVE = process.env.E2E_LIVE;

// Playwright's own Chromium when it is installed (`pnpm exec playwright install chromium`), the system Chrome otherwise.
const channel = existsSync(chromium.executablePath()) ? undefined : 'chrome';
const browser = { ...devices['Desktop Chrome'], channel };

// The build bakes these in; pinning them keeps the suites independent of any local .env file.
const env = {
  NEXT_PUBLIC_NEAR_NETWORK: 'testnet',
  NEXT_PUBLIC_INDEXER_URL: 'http://localhost:5100',
  NEXT_PUBLIC_RELAYER_URL: 'http://localhost:5200',
  NEXT_PUBLIC_AGENT_URL: 'http://localhost:5300',
  NEXT_PUBLIC_KEEPER_URL: 'http://localhost:5400',
  NEXT_PUBLIC_TOPUP_URL: 'http://localhost:5500',
  INDEXER_URL: 'http://localhost:5100',
};

const live = defineConfig({
  testDir: 'e2e',
  testMatch: /live\.spec\.ts/,
  retries: 0,
  reporter: 'list',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  use: { baseURL: LIVE, trace: 'retain-on-failure' },
  projects: [{ name: 'live', use: browser }],
});

const site = defineConfig({
  testDir: 'e2e',
  testIgnore: /live\.spec\.ts/,
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: { baseURL, trace: 'retain-on-failure' },
  projects: SHOTS
    ? [{ name: 'shots', grep: /@shots/, timeout: 60_000, use: browser }]
    : [{ name: 'site', grepInvert: /@shots/, use: browser }],
  webServer: {
    command: `pnpm build && pnpm exec next start --port ${PORT}`,
    url: `${baseURL}/llms.txt`,
    env,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

export default LIVE ? live : site;

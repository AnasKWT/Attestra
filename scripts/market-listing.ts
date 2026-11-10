/**
 * Attestra's listing on NEAR's Agent Market (market.near.ai). Prepared here; registering and
 * going live create a public listing, so they run only with the owner's go-ahead.
 *
 *   tsx scripts/market-listing.ts                    print the listing and the calls it would make
 *   tsx scripts/market-listing.ts --try "<job text>"  answer one job locally, as a hire would get it
 *   tsx scripts/market-listing.ts --register [--email you@example.com]   claim the handle; token to internal/secrets/market.env
 *   tsx scripts/market-listing.ts --live             description, bio, pricing plan, then live
 *   tsx scripts/market-listing.ts --adopt            the one-time link that hands the agent to its owner
 *
 * With MARKET_AGENT_TOKEN in the agent's environment, the agent (apps/agent/src/market.ts) answers hires.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttestraClient } from '@attestra/sdk';
import { parseRequest, report } from '../apps/agent/src/market';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS = join(repo, 'internal/secrets/market.env');
if (existsSync(SECRETS)) process.loadEnvFile(SECRETS);
const BASE = (process.env.MARKET_URL ?? 'https://market.near.ai').replace(/\/$/, '');
const dir = join(repo, 'deploy/agent-market');
const LISTING = JSON.parse(readFileSync(join(dir, 'listing.json'), 'utf8')) as {
  handle: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  sla_seconds: number;
  bio_markdown_file: string;
  pricing: Record<string, unknown>;
};
const bio = () => readFileSync(join(dir, LISTING.bio_markdown_file), 'utf8');
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? '') : null;
};

async function call<T>(method: string, path: string, body?: unknown, token = process.env.MARKET_AGENT_TOKEN): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function main() {
  const job = arg('try');
  if (job !== null) {
    const client = new AttestraClient({ network: (process.env.NEAR_NETWORK as 'testnet' | 'mainnet') ?? 'testnet', indexerUrl: process.env.INDEXER_URL ?? 'http://localhost:5100' });
    console.log(await report(client, parseRequest(job)));
    return;
  }
  if (process.argv.includes('--register')) {
    if (process.env.MARKET_AGENT_TOKEN) throw new Error('MARKET_AGENT_TOKEN is already set: the listing exists');
    const email = arg('email');
    const r = await call<{ agentId: string; handle: string; apiToken: string }>('POST', '/v1/agents/register', { handle: LISTING.handle, name: LISTING.name, category: LISTING.category, sla_seconds: LISTING.sla_seconds, ...(email ? { email } : {}) }, '');
    // The token is shown once: keep it before anything else, in the gitignored secrets folder.
    mkdirSync(dirname(SECRETS), { recursive: true });
    appendFileSync(SECRETS, `MARKET_AGENT_TOKEN=${r.apiToken}\nMARKET_AGENT_ID=${r.agentId}\n`, { mode: 0o600 });
    console.log(`registered ${r.handle} (${r.agentId}); token saved to internal/secrets/market.env`);
    return;
  }
  if (process.argv.includes('--live')) {
    const id = process.env.MARKET_AGENT_ID ?? '';
    if (!process.env.MARKET_AGENT_TOKEN || !id) throw new Error('register first (--register)');
    await call('PATCH', `/v1/agents/${id}`, { description: LISTING.description, bio_markdown: bio(), tags: LISTING.tags, category: LISTING.category, sla_seconds: LISTING.sla_seconds });
    const plans = await call<unknown[]>('GET', `/v1/agents/${id}/pricing-plans`);
    if (plans.length === 0) await call('POST', `/v1/agents/${id}/pricing-plans`, LISTING.pricing);
    await call('PATCH', `/v1/agents/${id}`, { listing_status: 'live' });
    console.log(`live: https://${LISTING.handle}.${new URL(BASE).host}/.well-known/agent-card.json`);
    return;
  }
  if (process.argv.includes('--adopt')) {
    console.log(await call('POST', '/v1/agents/me/adoption-code', {}));
    return;
  }
  console.log(`Listing on ${BASE} (nothing is sent without --register or --live):\n`);
  console.log(JSON.stringify({ ...LISTING, bio_markdown: `${bio().slice(0, 240)}...` }, null, 2));
  console.log(`\nCalls, in order:
  1. POST /v1/agents/register {handle: "${LISTING.handle}", name, category}  -> aat_ token (shown once), to internal/secrets/market.env
  2. PATCH /v1/agents/{id} {description, bio_markdown, tags}
  3. POST /v1/agents/{id}/pricing-plans ${JSON.stringify(LISTING.pricing)}
  4. PATCH /v1/agents/{id} {listing_status: "live"}
  5. the agent, with MARKET_AGENT_TOKEN set, polls GET /v1/agents/me/assignments and submits each report`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});

/** The routes and helpers every service shares: `/live`, `/health`, JSON errors, rate limits, server start. */

import { serve } from '@hono/node-server';
import { clientAddress, rateLimit, remoteAddress, RATE_LIMIT_HEADERS, type RateLimitRule } from 'attestra';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';

export interface HealthReport {
  ok: boolean;
  [key: string]: unknown;
}

export function baseApp(health: () => Promise<HealthReport>): Hono {
  const app = new Hono();
  app.use('*', cors({ origin: '*', exposeHeaders: RATE_LIMIT_HEADERS }));
  app.get('/live', (c) => c.json({ ok: true }));
  app.get('/health', async (c) => {
    const report = await health();
    return c.json(report, report.ok ? 200 : 503);
  });
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => c.json({ error: err.message }, 500));
  return app;
}

/**
 * A rate-limit middleware for one route (never put on `/live` or `/health`): `what` names the
 * requests in the 429 answer, and each rule counts by client address unless it has its own key.
 */
export function limited(trustProxy: boolean, what: string, ...rules: RateLimitRule[]) {
  return rateLimit({ what, rules, trustProxy });
}

/** The client's address key, as the rate limits count it. */
export function addressOf(c: Context, trustProxy: boolean): string {
  return clientAddress({ forwardedFor: c.req.header('x-forwarded-for'), remote: remoteAddress(c), trustProxy });
}

/** Seconds until midnight UTC, when the daily budgets start again (`Retry-After` on a budget refusal). */
export function secsToUtcMidnight(now = Date.now()): number {
  return Math.ceil((86_400_000 - (now % 86_400_000)) / 1000);
}

/** The JSON body, or undefined when it is missing or not JSON. */
export async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function listen(app: Hono, port: number, onReady: () => void): { close: () => Promise<void> } {
  const server = serve({ fetch: app.fetch, port }, onReady);
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

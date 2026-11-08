/** The routes and helpers every service shares: `/live`, `/health`, JSON errors, server start. */

import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';

export interface HealthReport {
  ok: boolean;
  [key: string]: unknown;
}

export function baseApp(health: () => Promise<HealthReport>): Hono {
  const app = new Hono();
  app.use('*', cors());
  app.get('/live', (c) => c.json({ ok: true }));
  app.get('/health', async (c) => {
    const report = await health();
    return c.json(report, report.ok ? 200 : 503);
  });
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => c.json({ error: err.message }, 500));
  return app;
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

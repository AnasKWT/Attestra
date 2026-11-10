/**
 * Indexer entry point: migrates the database, serves the REST API and runs the ingest loop.
 * `--resync` empties every indexed table first and reindexes from START_HEIGHT.
 */

import { serve } from '@hono/node-server';
import { AttestraClient } from '@attestra/sdk';
import { createApi } from './api';
import { loadConfig } from './config';
import { connect, migrate, reset } from './db';
import { ingestOnce, refreshDue } from './ingest';
import { TxApi } from './txapi';

const config = loadConfig();
const db = connect(config.databaseUrl);
const log = (m: string) => console.log(`${new Date().toISOString()} indexer ${m}`);

try {
  await migrate(db);
} catch (e) {
  const err = e as { code?: string; errors?: Array<{ code?: string }>; message?: string };
  const reason = err.code ?? err.errors?.[0]?.code ?? err.message ?? String(e);
  console.error(
    `indexer: cannot reach Postgres at ${config.databaseUrl.replace(/\/\/[^@]*@/, '//')} (${reason}).\n` +
      'Start Postgres and create the database (for example `createdb attestra`), or set DATABASE_URL; `docker compose up postgres` runs one.',
  );
  process.exit(1);
}
if (process.argv.includes('--resync')) {
  await reset(db);
  log(`resync: cleared, reindexing from ${config.startHeight}`);
}

const chain = new AttestraClient({ network: config.network, root: config.root, rpcUrl: config.rpcUrl });
const api = new TxApi(config.txApiUrl, config.fastnearKey);
const deps = { config, db, api, chain, log };

const app = createApi({
  db,
  network: config.network,
  startedAt: Date.now(),
  chainHead: async () => (await chain.rpc<{ header: { height: number } }>('block', { finality: 'final' })).header.height,
});
serve({ fetch: app.fetch, port: config.port }, () => log(`listening on :${config.port} (${config.network}, root ${config.root})`));

let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));

while (!stopping) {
  try {
    await ingestOnce(deps);
    await refreshDue(deps);
  } catch (e) {
    log(`pass failed: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, config.pollMs));
}
await db.end();
process.exit(0);

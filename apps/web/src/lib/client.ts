/** A shared read-only AttestraClient for pages; signing clients come from the wallet context. */

import { AttestraClient, IndexerClient } from 'attestra';
import { AGENT_URL, INDEXER_URL, KEEPER_URL, NETWORK, RELAYER_URL, ROOT } from './config';

let readClient: AttestraClient | undefined;

export function reader(): AttestraClient {
  readClient ??= new AttestraClient({ network: NETWORK, root: ROOT, indexerUrl: INDEXER_URL, relayerUrl: RELAYER_URL, agentUrl: AGENT_URL, keeperUrl: KEEPER_URL });
  return readClient;
}

export const indexer = new IndexerClient(INDEXER_URL);

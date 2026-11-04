/**
 * Client for the Attestra indexer's REST API (apps/indexer). The indexer reads the contracts'
 * NEP-297 events into Postgres; everything it serves can be checked against the chain with
 * `AttestraClient` views or a light client proof.
 */

import type {
  IndexedAttestation,
  IndexedAuthority,
  IndexedEvent,
  IndexedSchema,
  Paginated,
  ProfileSummary,
} from './types';

export interface AgentProfile {
  account_id: string;
  identity: IndexedAttestation | null;
  identity_fields: Record<string, unknown> | null;
  reviews: Array<IndexedAttestation & { fields: Record<string, unknown> | null }>;
  review_count: number;
  average_score: number | null;
  delegations: Array<Record<string, unknown>>;
  authority: IndexedAuthority | null;
}

export interface IndexerStats {
  schemas: number;
  attestations: number;
  authorities: number;
  events: number;
  agents: number;
  last_block: number | null;
  last_block_time: number | null;
}

export interface IndexerStatus {
  network: string;
  last_block: number | null;
  chain_head: number | null;
  lag_blocks: number | null;
  lag_seconds: number | null;
  caught_up: boolean;
}

export interface SearchResult {
  type: 'schema' | 'attestation' | 'authority' | 'account';
  id: string;
  label: string;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class IndexerClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async get<T>(path: string, query: Query = {}): Promise<T> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${this.base}${path}${qs ? `?${qs}` : ''}`;
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) throw Object.assign(new Error(`not found: ${path}`), { status: 404 });
    if (!res.ok) throw new Error(`indexer answered ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  listSchemas(q: { authority?: string; resolver?: string; search?: string; limit?: number; offset?: number } = {}) {
    return this.get<Paginated<IndexedSchema>>('/api/schemas', q);
  }

  getSchema(uid: string) {
    return this.get<IndexedSchema>(`/api/schemas/${uid}`);
  }

  listAttestations(
    q: { schema?: string; attester?: string; subject?: string; status?: string; limit?: number; offset?: number } = {},
  ) {
    return this.get<Paginated<IndexedAttestation>>('/api/attestations', q);
  }

  getAttestation(uid: string) {
    return this.get<IndexedAttestation>(`/api/attestations/${uid}`);
  }

  listAuthorities(q: { verified?: boolean; kind?: string; limit?: number; offset?: number } = {}) {
    return this.get<Paginated<IndexedAuthority>>('/api/authorities', q);
  }

  getAuthority(accountId: string) {
    return this.get<IndexedAuthority>(`/api/authorities/${accountId}`);
  }

  listEvents(q: { event?: string; contract?: string; account?: string; uid?: string; limit?: number; offset?: number } = {}) {
    return this.get<Paginated<IndexedEvent>>('/api/events', q);
  }

  getProfile(accountId: string) {
    return this.get<ProfileSummary>(`/api/profile/${accountId}`);
  }

  listAgents(q: { limit?: number; offset?: number } = {}) {
    return this.get<Paginated<AgentProfile>>('/api/agents', q);
  }

  getAgent(accountId: string) {
    return this.get<AgentProfile>(`/api/agents/${accountId}`);
  }

  search(q: string) {
    return this.get<{ results: SearchResult[] }>('/api/search', { q });
  }

  stats() {
    return this.get<IndexerStats>('/api/stats');
  }

  status() {
    return this.get<IndexerStatus>('/api/status');
  }
}

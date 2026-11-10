/**
 * The Attestra agent's worker on NEAR's Agent Market (market.near.ai): "Attestra verification".
 *
 * A buyer (a person or an agent) hires it with an attestation UID or an agent account in the job
 * text. It answers with a Markdown report: for a claim, whether the attestation is valid now and a
 * light client proof that its event is final, checked in this process; for an agent, its identity,
 * reviews and delegations from the chain. The same checks are sold per call over x402 at /v1/paid.
 *
 * It polls its assignments with its `aat_` token (MARKET_AGENT_TOKEN). The listing itself is made
 * by scripts/market-listing.ts and goes live only with the owner's go-ahead.
 */

import type { AttestraClient } from '@attestra/sdk';

export type MarketRequest = { kind: 'claim'; uid: string } | { kind: 'agent'; account: string };

const ACCOUNT = /\b((?:[a-z0-9]+[-_])*[a-z0-9]+(?:\.(?:[a-z0-9]+[-_])*[a-z0-9]+)*\.(?:near|testnet)|[0-9a-f]{64})\b/;

/** Finds what to check: a 64-hex attestation UID, or a NEAR account named as an agent. */
export function parseRequest(text: string): MarketRequest | null {
  const uid = /\b(?:0x)?([0-9a-fA-F]{64})\b/.exec(text);
  if (uid && !/\bagent\b/i.test(text.slice(0, uid.index))) return { kind: 'claim', uid: uid[1].toLowerCase() };
  const account = ACCOUNT.exec(text.toLowerCase());
  if (account) return { kind: 'agent', account: account[1] };
  if (uid) return { kind: 'claim', uid: uid[1].toLowerCase() };
  return null;
}

const HOW = 'Ask like this: "verify attestation 3f2a...c9" (a 64-hex UID) or "check agent scout.near".';

/** The deliverable: plain Markdown a person or an agent can read. */
export async function report(client: AttestraClient, req: MarketRequest | null): Promise<string> {
  if (!req) return `# Attestra verification\n\nI could not find an attestation UID or an agent account in the request.\n${HOW}\n`;
  if (req.kind === 'claim') {
    const a = await client.getAttestation(req.uid);
    if (!a.success || !a.data) return `# Attestation ${req.uid}\n\nNot found on ${client.network}: ${a.error?.message ?? 'no such attestation'}.\n`;
    const v = await client.isValid(req.uid);
    const p = await client.proveAttestation(req.uid);
    const lines = [
      `# Attestation ${req.uid}`,
      '',
      `- Valid now: **${v.data?.valid ? 'yes' : 'no'}** (status ${a.data.status})`,
      `- Schema: \`${a.data.schema_uid}\``,
      `- Attester: \`${a.data.attester}\`, subject: \`${a.data.subject}\``,
      p.success && p.data
        ? `- Final on NEAR: **${p.data.verified ? 'proven' : 'not proven'}** with a light client proof in block ${p.data.block.height} (${p.data.checks.filter((c) => c.ok).length} of ${p.data.checks.length} checks passed)`
        : `- Final on NEAR: not proven (${p.error?.message ?? 'no proof'})`,
      '',
      `Read it yourself with the Attestra CLI: \`attestra attestation verify ${req.uid}\` on ${client.network}.`,
    ];
    return `${lines.join('\n')}\n`;
  }
  const prof = await client.getAgentProfile(req.account);
  if (!prof.success || !prof.data) return `# Agent ${req.account}\n\nNo agent profile on ${client.network}: ${prof.error?.message ?? 'not found'}.\n`;
  const d = prof.data;
  const f = d.identity_fields ?? {};
  const lines = [
    `# Agent ${req.account}`,
    '',
    `- Identity: ${d.identity ? `${String(f.name ?? 'unnamed')} on ${String(f.model ?? 'an unnamed model')}, attestation \`${d.identity.uid}\` (${d.identity.status})` : 'none on chain'}`,
    `- Reviews: ${d.review_count}${d.average_score != null ? `, average ${d.average_score} of 5` : ''}`,
    `- Delegations: ${d.delegations.length}`,
  ];
  return `${lines.join('\n')}\n`;
}

interface Assignment {
  assignment: { assignmentId: string; status: string; startedAt: string | null };
  job: { jobId: string; title: string; description: string };
}

/** Polls the market for assignments and submits a report for each; returns a stop function. */
export function startMarketWorker(deps: { client: AttestraClient; token: string; base?: string; intervalMs?: number; fetchImpl?: typeof fetch }) {
  const base = (deps.base ?? 'https://market.near.ai').replace(/\/$/, '');
  const f = deps.fetchImpl ?? fetch;
  const stats = { delivered: 0, failed: 0, lastPollMs: 0 };
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const r = await f(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`${path} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  };
  const busy = new Set<string>();
  const poll = async () => {
    const { assignments } = await api<{ assignments: Assignment[] }>('/v1/agents/me/assignments');
    stats.lastPollMs = Date.now();
    await Promise.all(
      assignments
        .filter((a) => a.assignment.status === 'in_progress' && !busy.has(a.assignment.assignmentId))
        .map(async (a) => {
          const id = a.assignment.assignmentId;
          busy.add(id);
          try {
            if (!a.assignment.startedAt) await api(`/v1/assignments/${id}/start`, {});
            const md = await report(deps.client, parseRequest(`${a.job.title}\n${a.job.description}`));
            await api(`/v1/assignments/${id}/submit`, { deliverableMarkdown: md });
            stats.delivered++;
          } catch (e) {
            stats.failed++;
            console.error(`market: assignment ${id}: ${(e as Error).message}`);
          } finally {
            busy.delete(id);
          }
        }),
    );
  };
  const timer = setInterval(() => void poll().catch((e) => console.error(`market: ${(e as Error).message}`)), deps.intervalMs ?? 15_000);
  return { stats, poll, stop: () => clearInterval(timer) };
}

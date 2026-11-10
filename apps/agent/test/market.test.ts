import { describe, expect, it, vi } from 'vitest';
import type { AttestraClient } from '@attestra/sdk';
import { parseRequest, report, startMarketWorker } from '../src/market';

const UID = 'ab'.repeat(32);

function fakeClient(): AttestraClient {
  return {
    network: 'testnet',
    getAttestation: async (uid: string) =>
      uid === UID ? { success: true, data: { uid, status: 'active', schema_uid: 'cd'.repeat(32), attester: 'alice.testnet', subject: 'bob.testnet' } } : { success: false, error: { type: 'NOT_FOUND', message: 'attestation not found' } },
    isValid: async () => ({ success: true, data: { valid: true } }),
    proveAttestation: async () => ({ success: true, data: { verified: true, block: { height: 42 }, checks: [{ ok: true }, { ok: true }] } }),
    getAgentProfile: async (a: string) => ({
      success: true,
      data: { account_id: a, identity: { uid: 'ef'.repeat(32), status: 'active' }, identity_fields: { name: 'Scout', model: 'z-ai/glm-5.3-flash' }, reviews: [], review_count: 2, average_score: 4.5, delegations: [{}] },
    }),
  } as unknown as AttestraClient;
}

describe('agent market worker', () => {
  it('finds a claim UID or an agent account in the job text', () => {
    expect(parseRequest(`Please verify attestation 0x${UID}`)).toEqual({ kind: 'claim', uid: UID });
    expect(parseRequest('check agent scout.testnet before I hire it')).toEqual({ kind: 'agent', account: 'scout.testnet' });
    expect(parseRequest('Is research-agent.near trustworthy?')).toEqual({ kind: 'agent', account: 'research-agent.near' });
    expect(parseRequest('hello')).toBeNull();
  });

  it('reports a valid claim with its light client proof, and an agent with its reputation', async () => {
    const claim = await report(fakeClient(), { kind: 'claim', uid: UID });
    expect(claim).toContain('Valid now: **yes**');
    expect(claim).toContain('**proven** with a light client proof in block 42 (2 of 2 checks passed)');
    const agent = await report(fakeClient(), { kind: 'agent', account: 'scout.testnet' });
    expect(agent).toContain('Scout on z-ai/glm-5.3-flash');
    expect(agent).toContain('Reviews: 2, average 4.5 of 5');
    expect(await report(fakeClient(), { kind: 'claim', uid: '00'.repeat(32) })).toContain('Not found on testnet');
    expect(await report(fakeClient(), null)).toContain('Ask like this');
  });

  it('starts an assignment, submits the report and counts it', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string | undefined });
      const json = url.endsWith('/assignments')
        ? { assignments: [{ assignment: { assignmentId: 'as1', status: 'in_progress', startedAt: null }, job: { jobId: 'j1', title: 'Verify a claim', description: `uid ${UID}` } }] }
        : {};
      return new Response(JSON.stringify(json));
    }) as unknown as typeof fetch;
    const w = startMarketWorker({ client: fakeClient(), token: 'aat_test', base: 'https://market.example', intervalMs: 3_600_000, fetchImpl });
    await w.poll();
    w.stop();
    expect(calls.map((c) => c.url)).toEqual(['https://market.example/v1/agents/me/assignments', 'https://market.example/v1/assignments/as1/start', 'https://market.example/v1/assignments/as1/submit']);
    expect(JSON.parse(calls[2].body!).deliverableMarkdown).toContain('Valid now: **yes**');
    expect(w.stats.delivered).toBe(1);
  });
});

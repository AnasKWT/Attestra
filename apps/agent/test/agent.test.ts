import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AttestraClient, IndexerClient, KNOWN_SCHEMAS, SchemaEncoder, base58Decode, base58Encode, base64ToBytes, bytesToHex, decryptWithEd25519Seed, encryptForModel, keySigner, knownSchemaUid, signPrivateCheck, verdictDigest, x402, type AgentProfile } from 'attestra';
import { createApp, verifyAgent } from '../src/app';
import { githubMergedPrs, rulePrompt, runCheck } from '../src/check';
import { loadConfig } from '../src/config';
import { NearAi, sha256Hex, signedHashes, verifySignature } from '../src/nearai';

const modelSeed = new Uint8Array(32).fill(7);
const modelPub = bytesToHex(ed25519.getPublicKey(modelSeed));
const checkerSecret = 'ed25519:' + (await import('attestra')).base58Encode(new Uint8Array(32).fill(9));

/** A NEAR AI Cloud stand-in: decrypts E2EE messages with the model key, answers, signs like the gateway. */
function fakeNearAi(answer = 'PASS') {
  const chats = new Map<string, { req: string; res: string }>();
  let seen: string[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.endsWith('/model/list')) return Response.json({ models: [{ modelId: 'z-ai/glm-5.3-flash', metadata: { verifiable: true } }, { modelId: 'openai/gpt', metadata: { verifiable: false } }] });
    if (u.includes('/attestation/report')) return Response.json({ model_attestations: [{ signing_public_key: modelPub }] });
    if (u.endsWith('/chat/completions')) {
      const req = String(init?.body);
      const j = JSON.parse(req) as { messages: Array<{ content: string }> };
      seen = j.messages.map((m) => decryptWithEd25519Seed(m.content, modelSeed));
      const client = (init?.headers as Record<string, string>)['X-Client-Pub-Key'];
      const res = JSON.stringify({ id: 'chat-1', model: 'z-ai/glm-5.3-flash', choices: [{ message: { role: 'assistant', content: encryptForModel(answer, client) } }] });
      chats.set('chat-1', { req, res });
      return new Response(res, { status: 200 });
    }
    if (u.includes('/signature/chat-1')) {
      const c = chats.get('chat-1')!;
      const text = `z-ai/glm-5.3-flash:${sha256Hex(c.req)}:${sha256Hex(c.res)}`;
      return Response.json({ text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), modelSeed)), signing_algo: 'ed25519' });
    }
    return new Response('nope', { status: 404 });
  };
  return { f: f as typeof fetch, seen: () => seen };
}

describe('NEAR AI signatures', () => {
  it('verifies ed25519 and EIP-191 secp256k1 signatures and rejects tampering', () => {
    const text = 'm:aa:bb';
    const sig = bytesToHex(ed25519.sign(new TextEncoder().encode(text), modelSeed));
    expect(verifySignature({ text, signature: sig, signing_algo: 'ed25519' }, { ed25519: modelPub })).toBe(true);
    expect(verifySignature({ text: 'm:aa:bc', signature: sig, signing_algo: 'ed25519' }, { ed25519: modelPub })).toBe(false);

    const sk = new Uint8Array(32).fill(3);
    const msg = new TextEncoder().encode(text);
    const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
    const s = secp256k1.sign(digest, sk, { prehash: false, format: 'recovered' } as never) as unknown as Uint8Array;
    const rec = s[0];
    const raw = new Uint8Array([...s.slice(1), rec + 27]);
    const addr = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(sk, false).slice(1)).slice(-20))}`;
    expect(verifySignature({ text, signature: bytesToHex(raw), signing_algo: 'ecdsa' }, { address: addr })).toBe(true);
    expect(verifySignature({ text, signature: bytesToHex(raw), signing_algo: 'ecdsa' }, { address: '0x' + '11'.repeat(20) })).toBe(false);
    expect(signedHashes('a/b:1:2')).toEqual({ model: 'a/b', requestHash: '1', responseHash: '2' });
    expect(signedHashes('1:2').model).toBeUndefined();
  });

  it('picks only verifiable models', async () => {
    const ai = new NearAi('k', fakeNearAi().f);
    expect(await ai.pickModel()).toBe('z-ai/glm-5.3-flash');
    await expect(ai.pickModel('openai/gpt')).rejects.toThrow(/not a verifiable/);
  });
});

describe('private check pipeline', () => {
  const rule = { id: 'age_over_18', claim: 'is at least 18 years old', enabled: true };
  const subjectSigner = keySigner(`ed25519:${base58Encode(new Uint8Array(32).fill(4))}`);
  const keys = { hasFullAccessKey: (account: string, key: string) => Promise.resolve(key === subjectSigner.publicKey && account.endsWith('.testnet')), recipient: 'verdicts.attestra.testnet' };
  /** The check input, signed by its subject. */
  const signed = async (subject: string, encryptedEvidence: string, github: string | null = null) => ({
    rule,
    subject,
    encryptedEvidence,
    github,
    subjectProof: await signPrivateCheck(subjectSigner, { ruleId: rule.id, subject, encryptedEvidence, github }, 'verdicts.attestra.testnet'),
  });

  it('encrypts end to end, checks the model signature and signs a verdict the contract can verify', async () => {
    const fake = fakeNearAi('PASS');
    const ai = new NearAi('k', fake.f);
    const evidence = encryptForModel('Date of birth: 1990-04-02', modelPub);
    const out = await runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, await signed('bob.testnet', evidence), keys);
    expect(fake.seen()[0]).toBe(rulePrompt(rule));
    expect(fake.seen()[1]).toBe('Date of birth: 1990-04-02');
    expect(out.verdict.result).toBe(true);
    expect(out.answer).toBe('PASS');
    expect(signedHashes(out.nearai.text).requestHash).toBe(out.verdict.evidence_hash);
    const pk = base58Decode(out.enclaveKey.slice(8));
    expect(ed25519.verify(base64ToBytes(out.enclaveSignature), verdictDigest(out.verdict), pk)).toBe(true);
    expect(verifySignature({ text: out.nearai.text, signature: out.nearai.signature, signing_algo: 'ed25519' }, { ed25519: out.nearai.key })).toBe(true);
  });

  it('a FAIL answer becomes result false', async () => {
    const ai = new NearAi('k', fakeNearAi('FAIL').f);
    const out = await runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, await signed('bob.testnet', encryptForModel('nothing', modelPub)), keys);
    expect(out.verdict.result).toBe(false);
  });

  it('treats an empty answer (a reasoning model cut off) as an error, not a FAIL', async () => {
    const ai = new NearAi('k', fakeNearAi('').f);
    await expect(runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, await signed('bob.testnet', encryptForModel('born 1990', modelPub)), keys)).rejects.toThrow(/no verdict/);
  });

  it('refuses a model signature over another response', async () => {
    const fake = fakeNearAi('PASS');
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await fake.f(url, init);
      if (!String(url).includes('/signature/')) return res;
      const sig = (await res.json()) as { text: string };
      const text = sig.text.replace(/:[0-9a-f]{64}$/, `:${'00'.repeat(32)}`);
      return Response.json({ ...sig, text, signature: bytesToHex(ed25519.sign(new TextEncoder().encode(text), modelSeed)) });
    }) as typeof fetch;
    const ai = new NearAi('k', f);
    await expect(runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, await signed('b.testnet', encryptForModel('x', modelPub)), keys)).rejects.toThrow(/different response/);
  });

  it('refuses a check its subject did not sign', async () => {
    const ai = new NearAi('k', fakeNearAi().f);
    const evidence = encryptForModel('born 1990', modelPub);
    await expect(runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, { rule, subject: 'bob.testnet', encryptedEvidence: evidence }, keys)).rejects.toThrow(/must sign/);
    const forOther = await signed('bob.testnet', evidence);
    await expect(runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, { ...forOther, subject: 'carol.testnet' }, keys)).rejects.toThrow(/another rule or subject/);
  });

  it('refuses plaintext evidence', async () => {
    const ai = new NearAi('k', fakeNearAi().f);
    await expect(runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, await signed('bob.testnet', 'my passport says 1990'), keys)).rejects.toThrow(/encrypted/);
  });

  it('counts GitHub merged pull requests itself', async () => {
    const f = (async () => Response.json({ total_count: 12 })) as unknown as typeof fetch;
    expect(await githubMergedPrs('octocat', undefined, f)).toBe(12);
    await expect(githubMergedPrs('bad login!', undefined, f)).rejects.toThrow();
  });
});

describe('agent HTTP API (idle, no keys)', () => {
  const config = { ...loadConfig({}), nearAiKey: undefined };
  const app = createApp({ config, ai: new NearAi(undefined), client: new AttestraClient({ network: 'testnet' }), near: null, startedAt: Date.now() });

  it('serves liveness, health with reasons, the agent card and MCP', async () => {
    expect((await app.request('/live')).status).toBe(200);
    const h = await app.request('/health');
    expect(h.status).toBe(503);
    expect(((await h.json()) as { reason: string }).reason).toMatch(/NEARAI_API_KEY/);
    const card = (await (await app.request('/.well-known/agent-card.json')).json()) as { skills: unknown[]; url: string };
    expect(card.skills.length).toBe(3);
    const mcp = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(mcp.status).toBe(200);
  });

  it('answers 402 with x402 requirements on paid endpoints', async () => {
    const res = await app.request(`/v1/paid/verify-claim?uid=${'ab'.repeat(32)}`);
    expect(res.status).toBe(402);
    const req = x402.decodeHeader<x402.PaymentRequired>(res.headers.get('PAYMENT-REQUIRED')!);
    expect(req.accepts[0]).toMatchObject({ scheme: 'exact', network: 'near:testnet', asset: 'token.attestra.testnet', payTo: 'agent.attestra.testnet' });
    expect((await app.request('/v1/paid/verify-claim?uid=bad')).status).toBe(400);

    // Behind a proxy that strips a path prefix, the challenge names the public URL a client can call.
    const proxied = createApp({ config: { ...config, publicUrl: 'https://api.example.com/agent' }, ai: new NearAi(undefined), client: new AttestraClient({ network: 'testnet' }), near: null, startedAt: Date.now() });
    const challenge = await proxied.request(`http://agent:5300/v1/paid/verify-claim?uid=${'ab'.repeat(32)}`);
    expect(x402.decodeHeader<x402.PaymentRequired>(challenge.headers.get('PAYMENT-REQUIRED')!).resource.url).toBe(`https://api.example.com/agent/v1/paid/verify-claim?uid=${'ab'.repeat(32)}`);
    const bad = await app.request(`/v1/paid/verify-agent?agent=a.testnet`, { headers: { 'PAYMENT-SIGNATURE': x402.encodeHeader({ x402Version: 2, scheme: 'exact', network: 'near:testnet', payload: { signedDelegateAction: 'AA' } }) } });
    expect(bad.status).toBe(402);
  });

  it('explains when chat and checks are off, and validates A2A', async () => {
    expect((await app.request('/v1/chat', { method: 'POST', body: '{}' })).status).toBe(503);
    expect((await app.request('/v1/check', { method: 'POST', body: '{}' })).status).toBe(503);
    const a2a = (await (await app.request('/a2a', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get' }) })).json()) as { error: { code: number } };
    expect(a2a.error.code).toBe(-32601);
  });
});

describe('agent rate limits', () => {
  const limited = (env: NodeJS.ProcessEnv) =>
    createApp({ config: { ...loadConfig(env), nearAiKey: undefined }, ai: new NearAi(undefined), client: new AttestraClient({ network: 'testnet' }), near: null, startedAt: Date.now() });

  it('limits chat and A2A together per client address, and never /live or /health', async () => {
    const app = limited({ AGENT_RATE_CHAT_IP: '2/10m' });
    expect((await app.request('/v1/chat', { method: 'POST', body: '{}' })).status).toBe(503);
    const a2a = await app.request('/a2a', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get' }) });
    expect(a2a.headers.get('ratelimit-remaining')).toBe('0');
    const refused = await app.request('/v1/chat', { method: 'POST', body: '{}' });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('300');
    expect(((await refused.json()) as { error: string }).error).toBe('Too Many Requests: chats are limited to 2 per 10 minutes from one address; try again in 5 minutes.');
    expect((await app.request('/a2a', { method: 'POST', body: '{}' })).status).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/live')).status).toBe(200);
      expect((await app.request('/health')).status).toBe(503);
    }
  });

  it('caps chats per day across every client', async () => {
    const app = limited({ AGENT_CHAT_DAILY: '1', TRUST_PROXY: 'true' });
    expect((await app.request('/v1/chat', { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '198.51.100.1' } })).status).toBe(503);
    const refused = await app.request('/v1/chat', { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '198.51.100.2' } });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toMatch(/limited to 1 per day in total/);
  });

  it('limits the free 402 challenge, settlement attempts, job polls and MCP on their own', async () => {
    const app = limited({ AGENT_RATE_PAID_IP: '1/10m', AGENT_RATE_SETTLE_IP: '1/10m', AGENT_RATE_JOBS_IP: '1/1m', AGENT_RATE_MCP_IP: '1/1m' });
    const claim = `/v1/paid/verify-claim?uid=${'ab'.repeat(32)}`;
    expect((await app.request(claim)).status).toBe(402);
    expect((await app.request(claim)).status).toBe(429);
    const payment = { headers: { 'PAYMENT-SIGNATURE': x402.encodeHeader({ x402Version: 2, scheme: 'exact', network: 'near:testnet', payload: { signedDelegateAction: 'AA' } }) } };
    expect((await app.request(claim, payment)).status).toBe(402);
    const settle = await app.request(claim, payment);
    expect(settle.status).toBe(429);
    expect(((await settle.json()) as { error: string }).error).toMatch(/with a payment from one address/);
    expect((await app.request('/v1/check/jobs/nope')).status).toBe(404);
    expect((await app.request('/v1/check/jobs/nope')).status).toBe(429);
    const mcp = () => app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect((await mcp()).status).toBe(200);
    expect((await mcp()).status).toBe(429);
    expect((await app.request('/.well-known/agent-card.json')).status).toBe(200);
  });
});

describe('paid agent verification (verify-agent)', () => {
  /** A `tx` RPC result recorded on testnet: an implicit account staked tokens with ft_transfer_call to staking.attestra.testnet. */
  const ftCall = JSON.parse(readFileSync(new URL('../../../packages/sdk/test/fixtures/payments.json', import.meta.url), 'utf8')).ft_transfer_call;
  const FT_CALL = '2mb2KTtgAnfQghErTVU39v5PCgzAegnqsH3Ux5mvKbGx';
  const STAKER = '3b114b03396a55f07b8a17cd43a6e72cd89a11235f8197e8b64b0c01f4aba05c';
  const AGENT = 'staking.attestra.testnet';
  let n = 0;
  const att = (schema: 'agentIdentity' | 'agentReview', attester: string, fields: Record<string, unknown>) => ({
    uid: (++n).toString(16).padStart(64, '0'),
    schema_uid: knownSchemaUid(schema),
    attester,
    subject: AGENT,
    data: new SchemaEncoder(KNOWN_SCHEMAS[schema].definition).encode(fields),
    created_at: 1_700_000_000 + n,
    expiration_time: 0,
    revoked: false,
    revocation_time: 0,
    revoke_at: 0,
    nonce: n,
    ref_uid: null,
    status: 'active' as const,
    tx_hash: null,
    block_height: null,
    revoke_tx_hash: null,
  });
  const identity = (attester: string) => att('agentIdentity', attester, { name: 'Staker', owner: attester, model: 'm', capabilities: [], endpoint: '', description: '' });
  const review = (attester: string, score: number, job_ref: string) => att('agentReview', attester, { score, comment: '', job_ref });

  /** The SDK's own getAgentProfile over a fixed indexer answer and the recorded transaction. */
  function clientWith(identities: ReturnType<typeof identity>[], reviews: ReturnType<typeof review>[]) {
    const raw = { account_id: AGENT, identity: identities[0] ?? null, identities, reviews, delegations: [], authority: null } as unknown as AgentProfile;
    class Fake extends AttestraClient {
      override readonly indexer = { getAgent: async () => raw } as unknown as IndexerClient;
      override async rpc<T>(_m: string, p: unknown): Promise<T> {
        if ((p as { tx_hash: string }).tx_hash === FT_CALL) return ftCall as T;
        throw Object.assign(new Error('unknown'), { rpc: true, cause: 'UNKNOWN_TRANSACTION' });
      }
    }
    return new Fake({ network: 'testnet' });
  }

  it('trusts an agent with a verified identity and a paid review of at least 3.5', async () => {
    const r = await verifyAgent(clientWith([identity(AGENT)], [review(STAKER, 4, FT_CALL)]), AGENT);
    expect(r).toMatchObject({ agent: AGENT, identity_status: 'verified', paid_review_count: 1, paid_average_score: 4, trusted: true, trust_reasons: [] });
  });

  it('refuses an identity by a stranger, owner and self reviews, a forged job_ref and a low paid average, with reasons', async () => {
    const stranger = await verifyAgent(clientWith([identity('mallory.testnet')], [review('mallory.testnet', 5, ''), review(STAKER, 5, FT_CALL)]), AGENT);
    expect(stranger).toMatchObject({ identity_status: 'unverified', review_count: 1, paid_review_count: 1, excluded_reasons: { owner: 1 }, trusted: false });
    expect(stranger.trust_reasons).toEqual([expect.stringMatching(/^the identity is unverified: mallory\.testnet is neither/)]);

    const unpaid = await verifyAgent(clientWith([identity(AGENT)], [review(AGENT, 5, FT_CALL), review('bob.testnet', 5, FT_CALL), review('carol.testnet', 5, 'paid in full')]), AGENT);
    expect(unpaid).toMatchObject({ review_count: 2, average_score: 5, paid_review_count: 0, excluded_reasons: { self_review: 1 }, trusted: false });
    expect(unpaid.trust_reasons).toEqual([expect.stringMatching(/^no paid review/)]);

    const low = await verifyAgent(clientWith([identity(AGENT)], [review(STAKER, 3, FT_CALL)]), AGENT);
    expect(low).toMatchObject({ trusted: false, trust_reasons: ['the paid reviews average 3, below 3.5'] });
  });

  it('is not trusted when there is no profile', async () => {
    const r = await verifyAgent(new AttestraClient({ network: 'testnet' }), AGENT);
    expect(r).toMatchObject({ trusted: false, error: 'agent profiles need indexerUrl' });
    expect(r.trust_reasons[0]).toMatch(/^no agent profile/);
  });
});

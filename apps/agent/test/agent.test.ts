import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';
import { AttestraClient, base58Decode, base64ToBytes, bytesToHex, decryptWithEd25519Seed, encryptForModel, verdictDigest, x402 } from 'attestra';
import { createApp } from '../src/app';
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

  it('encrypts end to end, checks the model signature and signs a verdict the contract can verify', async () => {
    const fake = fakeNearAi('PASS');
    const ai = new NearAi('k', fake.f);
    const evidence = encryptForModel('Date of birth: 1990-04-02', modelPub);
    const out = await runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, { rule, subject: 'bob.testnet', encryptedEvidence: evidence });
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
    const out = await runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, { rule, subject: 'bob.testnet', encryptedEvidence: encryptForModel('nothing', modelPub) });
    expect(out.verdict.result).toBe(false);
  });

  it('treats an empty answer (a reasoning model cut off) as an error, not a FAIL', async () => {
    const ai = new NearAi('k', fakeNearAi('').f);
    await expect(runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, { rule, subject: 'bob.testnet', encryptedEvidence: encryptForModel('born 1990', modelPub) })).rejects.toThrow(/no verdict/);
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
    await expect(runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, { rule, subject: 'b.testnet', encryptedEvidence: encryptForModel('x', modelPub) })).rejects.toThrow(/different response/);
  });

  it('refuses plaintext evidence', async () => {
    const ai = new NearAi('k', fakeNearAi().f);
    await expect(runCheck(ai, 'z-ai/glm-5.3-flash', checkerSecret, { rule, subject: 'b', encryptedEvidence: 'my passport says 1990' })).rejects.toThrow(/encrypted/);
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

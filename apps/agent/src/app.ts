/** The agent's HTTP API: chat, private checks, paid verification (x402), A2A and MCP. */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handleMcpRequest } from 'attestra-mcp';
import { bytesToHex, DailyBudget, errorMessage, RATE_LIMIT_HEADERS, rateLimit, takeAll, TokenBucket, tooManyRequests, verifySubjectProof, x402, type AttestraClient, type Outcome, type RateLimitRule, type SubjectProof } from 'attestra';
import type { Near } from 'near-kit';
import { a2aError, a2aReply, agentCard, textOf, type A2ARequest } from './a2a';
import { chat, type ChatTurn } from './chat';
import { publicKeyOf, runCheck, type Rule } from './check';
import type { AgentConfig } from './config';
import { NearAi, VERIFY_URL } from './nearai';
import { checkerRequest, isDroppedRun, nearChain, OUTLAYER_TRIES, runCheckOnOutLayer, type OutLayerChain, type OutLayerConfig } from './outlayer';
import { paid, requirements } from './paid';

/** How long a finished check job can still be read. */
const JOB_TTL_MS = 60 * 60_000;

export interface AgentDeps {
  config: AgentConfig;
  ai: NearAi;
  /** Reads (and, with a key, writes) as the agent account. */
  client: AttestraClient;
  near: Near | null;
  startedAt: number;
  /** The chain the OutLayer checker is requested on; defaults to `near` as the agent account. */
  outlayer?: OutLayerChain;
}

/** The OutLayer request settings, or the reason the outlayer checker cannot run. */
export function outlayerSettings(config: AgentConfig): OutLayerConfig | string {
  if (!config.outlayerWasmUrl || !config.outlayerWasmHash) return 'OUTLAYER_WASM_URL and OUTLAYER_WASM_HASH are not set: private checks are off';
  return {
    contract: config.net.outlayer,
    wasmUrl: config.outlayerWasmUrl,
    wasmHash: config.outlayerWasmHash,
    secretsOwner: config.accountId,
    secretsProfile: config.outlayerSecretsProfile,
  };
}

/**
 * The paid agent check: the profile under the SDK's reputation rules (payments checked on chain).
 * `trusted` needs a verified identity, at least one paid review and a paid average of at least 3.5;
 * `trust_reasons` says what is missing.
 */
export async function verifyAgent(client: AttestraClient, agent: string) {
  const p = await client.getAgentProfile(agent);
  if (!p.success || !p.data) return { agent, trusted: false, trust_reasons: [`no agent profile: ${p.error?.message ?? 'not found'}`], error: p.error?.message };
  return { agent, ...p.data, trusted: p.data.trusted, trust_reasons: p.data.trust_reasons };
}

export function createApp(d: AgentDeps) {
  const app = new Hono();
  app.use('*', cors({ origin: '*', exposeHeaders: [x402.X402_HEADERS.required, x402.X402_HEADERS.response, ...RATE_LIMIT_HEADERS] }));

  // ─── rate limits (never on /live or /health) ─────────────────────────
  // Per client address in front of every route that spends NEAR AI credits, OutLayer fees or gas,
  // or loads the chain; daily budgets cap what all clients spend together. A private check also
  // counts per subject, once the subject's signature verified, so nobody can use up another's.
  const rates = d.config.rates;
  const limits = { checkSubject: new TokenBucket(rates.checkSubject), checkDaily: new DailyBudget(rates.checkDaily) };
  const limit = (what: string, ...rules: RateLimitRule[]) => rateLimit({ what, rules, trustProxy: d.config.trustProxy });
  const chatLimit = limit('chats', { limiter: new TokenBucket(rates.chatIp) }, { limiter: new DailyBudget(rates.chatDaily), key: () => 'chat', scope: 'in total' });
  const paying = (c: { req: { header(name: string): string | undefined } }) => Boolean(c.req.header(x402.X402_HEADERS.signature));
  app.on('POST', '/v1/check', limit('private checks', { limiter: new TokenBucket(rates.checkIp) }));
  app.on('GET', '/v1/check/model', limit('model key reads', { limiter: new TokenBucket(rates.modelIp) }));
  app.on('GET', '/v1/check/jobs/:job', limit('check job reads', { limiter: new TokenBucket(rates.jobsIp) }));
  app.on('POST', '/v1/chat', chatLimit);
  app.on('POST', '/a2a', chatLimit);
  app.use('/mcp', limit('MCP requests', { limiter: new TokenBucket(rates.mcpIp) }));
  app.on(
    'GET',
    '/v1/paid/*',
    limit(
      'paid verification requests',
      { limiter: new TokenBucket(rates.paidIp), key: (c, address) => (paying(c) ? undefined : address), scope: 'from one address' },
      { limiter: new TokenBucket(rates.settleIp), key: (c, address) => (paying(c) ? address : undefined), scope: 'with a payment from one address' },
    ),
  );
  const stats = { chats: 0, checks: 0, paid: 0, errors: 0, lastError: '' };
  let modelCache: { id: string; at: number } | null = null;
  const model = async () => {
    if (modelCache && Date.now() - modelCache.at < 600_000) return modelCache.id;
    const id = await d.ai.pickModel(d.config.model);
    modelCache = { id, at: Date.now() };
    return id;
  };
  const outlayer = d.config.checkerMode === 'outlayer' ? outlayerSettings(d.config) : null;
  const checkerOff = outlayer === null ? (d.config.checkerKey ? null : 'CHECKER_PRIVATE_KEY is not set: private checks are off') : typeof outlayer === 'string' ? outlayer : null;
  const fail = (e: unknown) => {
    stats.errors++;
    stats.lastError = (e as Error).message.slice(0, 300);
    return (e as Error).message;
  };

  app.get('/live', (c) => c.json({ ok: true }));
  app.get('/health', async (c) => {
    const reasons: string[] = [];
    if (!d.ai.configured) reasons.push('NEARAI_API_KEY is not set: chat and private checks are off');
    if (!d.near) reasons.push('AGENT_PRIVATE_KEY is not set: verdicts and x402 settlement are off');
    if (checkerOff) reasons.push(checkerOff);
    return c.json(
      {
        ok: reasons.length === 0,
        service: 'agent',
        network: d.config.network,
        account: d.config.accountId,
        model: modelCache?.id ?? d.config.model ?? null,
        checker:
          d.config.checkerMode === 'outlayer'
            ? { mode: 'outlayer', wasm_hash: d.config.outlayerWasmHash ?? null }
            : { mode: 'local', key: d.config.checkerKey ? publicKeyOf(d.config.checkerKey) : null },
        uptime_s: Math.floor((Date.now() - d.startedAt) / 1000),
        reason: reasons.join('; ') || undefined,
        stats,
      },
      reasons.length === 0 ? 200 : 503,
    );
  });

  // ─── chat ────────────────────────────────────────────────────────────
  app.post('/v1/chat', async (c) => {
    if (!d.ai.configured) return c.json({ error: 'the agent has no NEAR AI Cloud key yet' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { messages?: ChatTurn[] };
    const history = (body.messages ?? []).filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
    if (!history.length || history[history.length - 1].role !== 'user') return c.json({ error: 'send messages ending with a user message' }, 400);
    try {
      stats.chats++;
      return c.json(await chat(d.ai, d.client, await model(), history));
    } catch (e) {
      return c.json({ error: fail(e) }, 502);
    }
  });

  // ─── private checks ──────────────────────────────────────────────────
  app.get('/v1/check/model', async (c) => {
    if (!d.ai.configured) return c.json({ error: 'the agent has no NEAR AI Cloud key yet' }, 503);
    try {
      const id = await model();
      const keys = await d.ai.modelKeys(id);
      return c.json({ model: id, public_key: keys.ed25519, verify_url: VERIFY_URL });
    } catch (e) {
      return c.json({ error: fail(e) }, 502);
    }
  });

  type CheckBody = { rule_id?: string; subject?: string; encrypted_evidence?: string; github?: string | null; model?: string; async?: boolean; subject_proof?: SubjectProof };
  type CheckResult = { outcome: Outcome; verdict: unknown; nearai: unknown; tx_hash?: string };
  /** Runs one check and submits its verdict. An OutLayer run that the worker dropped is tried again. */
  /** Whether a key is a full-access key of an account, read from the chain (final). */
  const fullAccessKey = async (accountId: string, publicKey: string): Promise<boolean> => {
    try {
      const k = await d.client.rpc<{ permission?: unknown }>('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
      return k.permission === 'FullAccess';
    } catch (e) {
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(errorMessage(e))) return false;
      throw e;
    }
  };
  const runChecked = async (rule: Rule, id: string, body: CheckBody): Promise<CheckResult> => {
    let out;
    if (outlayer && typeof outlayer !== 'string') {
      for (let attempt = 1; ; attempt++) {
        try {
          out = await runCheckOnOutLayer(
            d.outlayer ?? nearChain(d.near!, d.config.accountId),
            outlayer,
            checkerRequest({
              requestId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
              ruleId: rule.id,
              subject: body.subject!,
              model: id,
              encryptedEvidence: body.encrypted_evidence ?? '',
              github: body.github,
              subjectProof: body.subject_proof!,
            }),
          );
          break;
        } catch (e) {
          if (attempt >= OUTLAYER_TRIES || !isDroppedRun(e)) throw e;
          console.warn(`${new Date().toISOString()} OutLayer dropped check run ${attempt} of ${OUTLAYER_TRIES}; trying again`);
        }
      }
    } else {
      out = await runCheck(d.ai, id, d.config.checkerKey!, { rule, subject: body.subject!, encryptedEvidence: body.encrypted_evidence ?? '', github: body.github, subjectProof: body.subject_proof }, { githubToken: d.config.githubToken, hasFullAccessKey: fullAccessKey, recipient: d.client.contracts.verdicts });
    }
    const r = await d.client.callRaw<Outcome>(d.client.contracts.verdicts, 'submit_ai_verdict', {
      verdict: out.verdict,
      enclave_key: out.enclaveKey,
      enclave_signature: out.enclaveSignature,
      nearai: out.nearai,
    });
    return { outcome: r.value, verdict: out.verdict, nearai: { ...out.nearai, model: id }, tx_hash: r.txHash };
  };

  // A check through OutLayer can take minutes when its queue is busy: `async: true` answers 202 with
  // a job id at once, and the caller polls GET /v1/check/jobs/:id instead of holding a connection.
  const jobs = new Map<string, { status: 'pending' | 'done' | 'failed'; result?: CheckResult; error?: string; at: number }>();
  const pruneJobs = () => {
    for (const [k, j] of jobs) if (Date.now() - j.at > JOB_TTL_MS) jobs.delete(k);
  };

  app.post('/v1/check', async (c) => {
    if (!d.ai.configured || checkerOff || !d.near) return c.json({ error: 'private checks are not configured on this agent' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as CheckBody;
    if (!body.rule_id || !body.subject) return c.json({ error: 'rule_id and subject are required' }, 400);
    try {
      const rules = (await d.client.view<Rule[]>(d.client.contracts.verdicts, 'get_rules')) ?? [];
      const rule = rules.find((r) => r.id === body.rule_id && r.enabled);
      if (!rule) return c.json({ error: `unknown or disabled rule ${body.rule_id}` }, 400);
      // The subject asked for this check: its key signed it (the TEE checks it again before signing).
      try {
        await verifySubjectProof({ proof: body.subject_proof, ruleId: rule.id, subject: body.subject, encryptedEvidence: body.encrypted_evidence ?? '', github: body.github, recipient: d.client.contracts.verdicts, hasFullAccessKey: fullAccessKey });
      } catch (e) {
        return c.json({ error: errorMessage(e) }, 403);
      }
      const id = await model();
      if (body.model && body.model !== id) return c.json({ error: `encrypt to ${id}, the model this agent uses` }, 409);
      const quota = takeAll([
        { limiter: limits.checkSubject, key: body.subject, scope: 'for one subject' },
        { limiter: limits.checkDaily, key: 'check', scope: 'in total' },
      ]);
      if (!quota.ok) return tooManyRequests(quota, 'private checks');
      stats.checks++;
      if (body.async) {
        pruneJobs();
        const job = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
        jobs.set(job, { status: 'pending', at: Date.now() });
        runChecked(rule, id, body).then(
          (result) => jobs.set(job, { status: 'done', result, at: Date.now() }),
          (e) => jobs.set(job, { status: 'failed', error: fail(e), at: Date.now() }),
        );
        return c.json({ job, status: 'pending' }, 202);
      }
      return c.json(await runChecked(rule, id, body));
    } catch (e) {
      return c.json({ error: fail(e) }, 502);
    }
  });

  app.get('/v1/check/jobs/:job', (c) => {
    const j = jobs.get(c.req.param('job'));
    if (!j) return c.json({ error: 'unknown or expired check job' }, 404);
    if (j.status === 'done') return c.json({ status: 'done', ...j.result });
    return c.json(j.status === 'failed' ? { status: 'failed', error: j.error } : { status: 'pending' });
  });

  // ─── paid verification (x402) ────────────────────────────────────────
  const paidDeps = { near: d.near, agentAccount: d.config.accountId, net: d.config.net, publicUrl: d.config.publicUrl };
  app.get('/v1/paid/verify-claim', async (c) => {
    const uid = c.req.query('uid') ?? '';
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(uid)) return c.json({ error: 'uid must be 64 hex characters' }, 400);
    return paid(c.req.raw, paidDeps, requirements(paidDeps, d.config.priceClaim, 'Verify an Attestra attestation and prove its event final'), async () => {
      stats.paid++;
      const a = await d.client.getAttestation(uid);
      const proof = a.success ? await d.client.proveAttestation(uid) : null;
      return { uid, found: a.success, attestation: a.data ?? null, valid: a.data?.status === 'active', proof: proof?.success ? { verified: proof.data!.verified, checks: proof.data!.checks, block: proof.data!.block } : { error: proof?.error?.message ?? a.error?.message } };
    });
  });
  app.get('/v1/paid/verify-agent', async (c) => {
    const agent = c.req.query('agent') ?? '';
    if (!agent) return c.json({ error: 'agent is required' }, 400);
    return paid(c.req.raw, paidDeps, requirements(paidDeps, d.config.priceAgent, 'Check an AI agent: identity, delegations and reputation'), async () => {
      stats.paid++;
      return verifyAgent(d.client, agent);
    });
  });

  // ─── A2A ─────────────────────────────────────────────────────────────
  const card = () => agentCard(d.config.publicUrl, d.config.network);
  app.get('/.well-known/agent-card.json', (c) => c.json(card()));
  app.get('/.well-known/agent.json', (c) => c.json(card()));
  app.post('/a2a', async (c) => {
    const req = (await c.req.json().catch(() => null)) as A2ARequest | null;
    if (!req || req.jsonrpc !== '2.0') return c.json(a2aError(null, -32600, 'invalid request'), 400);
    if (req.method !== 'message/send') return c.json(a2aError(req.id, -32601, `unsupported method ${req.method}`));
    const text = textOf(req);
    if (!text) return c.json(a2aError(req.id, -32602, 'send a text part'));
    if (!d.ai.configured) return c.json(a2aError(req.id, -32000, 'the agent has no NEAR AI Cloud key yet'));
    try {
      const r = await chat(d.ai, d.client, await model(), [{ role: 'user', content: text }]);
      return c.json(a2aReply(req.id, r.reply, { tools: r.tools, verification: r.verification }));
    } catch (e) {
      return c.json(a2aError(req.id, -32000, fail(e)));
    }
  });

  // ─── MCP (read tools) ────────────────────────────────────────────────
  app.all('/mcp', (c) =>
    handleMcpRequest(c.req.raw, { network: d.config.network, root: d.config.net.root, indexerUrl: d.config.indexerUrl, agentUrl: d.config.publicUrl, readOnly: true }),
  );

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}

/** The agent's HTTP API: chat, private checks, paid verification (x402), A2A and MCP. */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handleMcpRequest } from '@attestra/mcp';
import { bytesToHex, x402, type AttestraClient, type Outcome } from '@attestra/sdk';
import type { Near } from 'near-kit';
import { a2aError, a2aReply, agentCard, textOf, type A2ARequest } from './a2a';
import { chat, type ChatTurn } from './chat';
import { publicKeyOf, runCheck, type Rule } from './check';
import type { AgentConfig } from './config';
import { NearAi, VERIFY_URL } from './nearai';
import { checkerRequest, nearChain, runCheckOnOutLayer, type OutLayerChain, type OutLayerConfig } from './outlayer';
import { paid, requirements } from './paid';

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

export function createApp(d: AgentDeps) {
  const app = new Hono();
  app.use('*', cors({ origin: '*', exposeHeaders: [x402.X402_HEADERS.required, x402.X402_HEADERS.response] }));
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

  app.post('/v1/check', async (c) => {
    if (!d.ai.configured || checkerOff || !d.near) return c.json({ error: 'private checks are not configured on this agent' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { rule_id?: string; subject?: string; encrypted_evidence?: string; github?: string | null; model?: string };
    if (!body.rule_id || !body.subject) return c.json({ error: 'rule_id and subject are required' }, 400);
    try {
      const rules = (await d.client.view<Rule[]>(d.client.contracts.verdicts, 'get_rules')) ?? [];
      const rule = rules.find((r) => r.id === body.rule_id && r.enabled);
      if (!rule) return c.json({ error: `unknown or disabled rule ${body.rule_id}` }, 400);
      const id = await model();
      if (body.model && body.model !== id) return c.json({ error: `encrypt to ${id}, the model this agent uses` }, 409);
      stats.checks++;
      const out =
        outlayer && typeof outlayer !== 'string'
          ? await runCheckOnOutLayer(
              d.outlayer ?? nearChain(d.near, d.config.accountId),
              outlayer,
              checkerRequest({
                requestId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
                ruleId: rule.id,
                subject: body.subject,
                model: id,
                encryptedEvidence: body.encrypted_evidence ?? '',
                github: body.github,
              }),
            )
          : await runCheck(d.ai, id, d.config.checkerKey!, { rule, subject: body.subject, encryptedEvidence: body.encrypted_evidence ?? '', github: body.github }, { githubToken: d.config.githubToken });
      const r = await d.client.callRaw<Outcome>(d.client.contracts.verdicts, 'submit_ai_verdict', {
        verdict: out.verdict,
        enclave_key: out.enclaveKey,
        enclave_signature: out.enclaveSignature,
        nearai: out.nearai,
      });
      return c.json({ outcome: r.value, verdict: out.verdict, nearai: { ...out.nearai, model: id }, tx_hash: r.txHash });
    } catch (e) {
      return c.json({ error: fail(e) }, 502);
    }
  });

  // ─── paid verification (x402) ────────────────────────────────────────
  const paidDeps = { near: d.near, agentAccount: d.config.accountId, net: d.config.net };
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
      const p = await d.client.getAgentProfile(agent);
      return p.success ? { agent, ...p.data, trusted: Boolean(p.data?.identity) && (p.data?.average_score ?? 0) >= 3.5 } : { agent, error: p.error?.message };
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

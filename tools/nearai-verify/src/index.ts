#!/usr/bin/env node
/**
 * attestra-nearai-verify: the independent NEAR AI Cloud verifier, built on the official
 * `@nearai/inference-sdk` (the agent keeps its own checks in apps/agent/src/nearai.ts).
 *
 * For each model signer the verdicts contract trusts (or one given with --model/--expect-key) it
 * verifies the Gateway and model TEE attestations and that an attested report binds the trusted key;
 * optionally a chat's signature over its exact bytes (--chat-id) or a fresh tiny completion (--probe).
 */

import { readFileSync } from 'node:fs';
import { AttestationClient, createTdxQuoteVerifier, InferenceClient, type SigningAlgo } from '@nearai/inference-sdk/node';
import { nodeSupported, parseCli, render, USAGE, UsageError, type Options, type Summary } from './cli.js';
import { readTrustedSigners } from './contract.js';
import { attestModelWithFallback, failure, NEAR_AI_PCCS_URL, probe, verifyChat, type ModelReport, type TrustedSigner } from './verify.js';

function sdkVersion(): string | undefined {
  try {
    const pkg = new URL('../node_modules/@nearai/inference-sdk/package.json', import.meta.url);
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

async function run(o: Options, apiKey: string): Promise<Summary> {
  const summary: Summary = { ok: false, sdk: sdkVersion(), ...(o.contract ? { contract: o.contract } : {}), reports: [] };

  let targets: Array<{ model: string; algo: SigningAlgo; trusted?: TrustedSigner }>;
  if (o.expectKey) {
    targets = [{ model: o.model!, algo: o.algo, trusted: { model: o.model!, algo: o.algo, key: o.expectKey } }];
  } else if (o.contract) {
    let signers: TrustedSigner[];
    try {
      signers = await readTrustedSigners(o.rpc, o.contract);
    } catch (e) {
      return { ...summary, error: { code: 'contract.unreadable', message: failure(e).message } };
    }
    const picked = o.model ? signers.filter((s) => s.model === o.model) : signers;
    if (!picked.length) {
      return { ...summary, error: { code: 'contract.no_model_signer', message: `${o.contract} trusts no model signer${o.model ? ` for ${o.model}` : ''}` } };
    }
    targets = picked.map((s) => ({ model: s.model, algo: s.algo, trusted: s }));
  } else {
    targets = [{ model: o.model!, algo: o.algo }];
  }

  const clients = new Map<string, InferenceClient>();
  const clientFor = (algo: SigningAlgo, pccsUrl?: string) => {
    let c = clients.get(`${algo} ${pccsUrl ?? ''}`);
    if (!c) {
      const tdxQuote = pccsUrl ? createTdxQuoteVerifier({ pccsUrl }) : undefined;
      c = new InferenceClient({
        apiKey,
        signingAlgo: algo,
        ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
        ...(tdxQuote ? { gatewayVerification: { verifiers: { tdxQuote } } } : {}),
        modelVerification: { policy: { gpuEvidence: o.gpu }, ...(tdxQuote ? { verifiers: { tdxQuote } } : {}) },
      });
      clients.set(`${algo} ${pccsUrl ?? ''}`, c);
    }
    return c;
  };

  for (const t of targets) {
    const trusted = t.trusted ? { key: t.trusted.key, algo: t.trusted.algo } : undefined;
    const { report, models, verifier: client } = await attestModelWithFallback(clientFor(t.algo), () => clientFor(t.algo, NEAR_AI_PCCS_URL), t.model, trusted);
    const withResponse = async (r: ModelReport): Promise<ModelReport> => {
      if (!r.ok) return r;
      let response;
      if (o.chat) {
        const source = new AttestationClient({ apiKey, ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}) });
        response = await verifyChat({
          source,
          chatId: o.chat.id,
          requestBody: readFileSync(o.chat.requestFile),
          responseBody: readFileSync(o.chat.responseFile),
          attestations: models,
          algo: t.algo,
          trustedKey: t.trusted?.key,
        });
      } else if (o.probe) {
        response = await probe(client, t.model, t.trusted?.key);
      } else {
        return r;
      }
      return { ...r, ok: response.ok, response };
    };
    summary.reports.push(await withResponse(report));
  }
  for (const c of clients.values()) c.clearResponseCache();
  summary.ok = summary.reports.every((r) => r.ok);
  return summary;
}

async function main() {
  let o: Options;
  try {
    o = parseCli(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (o.help) {
    console.log(USAGE);
    return;
  }
  const apiKey = process.env.NEARAI_API_KEY;
  const summary: Summary = !nodeSupported(process.versions.node)
    ? { ok: false, sdk: sdkVersion(), reports: [], error: { code: 'config.node_too_old', message: `@nearai/inference-sdk needs Node >= 24.22.1, this is ${process.versions.node}` } }
    : apiKey
      ? await run(o, apiKey)
      : { ok: false, sdk: sdkVersion(), reports: [], error: { code: 'config.no_api_key', message: 'NEARAI_API_KEY is not set (model reports and signatures need a NEAR AI Cloud key)' } };
  console.log(o.json ? JSON.stringify(summary, null, 2) : render(summary));
  process.exitCode = summary.ok ? 0 : 1;
}

void main();

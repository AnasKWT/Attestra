/**
 * pnpm verify: checks every claim the README makes and prints PASS or FAIL for each.
 *
 *   pnpm verify                  everything (runs the test suites first)
 *   pnpm verify --skip-tests     only the live checks
 *
 * Env: SITE_URL (http://localhost:3100), INDEXER_URL (:5100), AGENT_URL (:5300), RELAYER_URL (:5200),
 * KEEPER_URL (:5400), TOPUP_URL (:5500), NEAR_NETWORK (testnet). Run the local stack first
 * (`pnpm dev` or `docker compose up`), or point the URLs at the hosted one.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  AttestraClient,
  IndexerClient,
  KNOWN_SCHEMAS,
  SchemaEncoder,
  base58Decode,
  base58Encode,
  base64ToBytes,
  findEventReceipt,
  knownSchemaUid,
  proveReceipt,
  verdictDigest,
  type AiVerdict,
  type Network,
} from '@attestra/sdk';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const network = (process.env.NEAR_NETWORK ?? 'testnet') as Network;
const SITE = (process.env.SITE_URL ?? 'http://localhost:3100').replace(/\/+$/, '');
const INDEXER = (process.env.INDEXER_URL ?? 'http://localhost:5100').replace(/\/+$/, '');
const AGENT = (process.env.AGENT_URL ?? 'http://localhost:5300').replace(/\/+$/, '');
const RELAYER = (process.env.RELAYER_URL ?? 'http://localhost:5200').replace(/\/+$/, '');
const KEEPER = (process.env.KEEPER_URL ?? 'http://localhost:5400').replace(/\/+$/, '');
const TOPUP = (process.env.TOPUP_URL ?? 'http://localhost:5500').replace(/\/+$/, '');
const skipTests = process.argv.includes('--skip-tests');

const results: Array<{ claim: string; ok: boolean; detail: string }> = [];
const c = new AttestraClient({ network, indexerUrl: INDEXER });
const idx = new IndexerClient(INDEXER);
const rpc = <T>(m: string, p: unknown) => c.rpc<T>(m, p);

async function check(claim: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    results.push({ claim, ok: true, detail });
    console.log(`\u001b[32mPASS\u001b[0m ${claim}${detail ? `\n     ${detail}` : ''}`);
  } catch (e) {
    results.push({ claim, ok: false, detail: (e as Error).message });
    console.log(`\u001b[31mFAIL\u001b[0m ${claim}\n     ${(e as Error).message}`);
  }
}

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function b58sha256(bytes: Buffer) {
  return base58Encode(createHash('sha256').update(bytes).digest());
}

async function txArgs(hash: string, signer: string): Promise<Record<string, unknown>> {
  const tx = await rpc<{ transaction: { actions: Array<{ FunctionCall?: { args: string } }> } }>('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: signer, wait_until: 'NONE' });
  const fc = tx.transaction.actions.find((a) => a.FunctionCall)?.FunctionCall;
  must(fc, 'the transaction has no function call');
  return JSON.parse(Buffer.from(fc.args, 'base64').toString('utf8'));
}

async function main() {
  console.log(`Attestra verify on NEAR ${network}\n`);

  if (!skipTests) {
    await check('Every TypeScript test suite passes (SDK, CLI, MCP, indexer, agent, services, site)', async () => {
      const r = spawnSync('pnpm', ['-r', '--if-present', 'test'], { cwd: root, encoding: 'utf8' });
      must(r.status === 0, `pnpm -r test failed:\n${(r.stdout + r.stderr).split('\n').filter((l) => /FAIL|failed|Error/.test(l)).slice(0, 8).join('\n')}`);
      const passed = (r.stdout.match(/Tests\s+\d+ passed/g) ?? []).map((l) => Number(l.match(/\d+/)![0])).reduce((a, b) => a + b, 0);
      return `${passed} tests`;
    });
    await check('Every contract unit test passes', async () => {
      const r = spawnSync('cargo', ['test', '--workspace', '--exclude', 'attestra-sandbox-tests'], { cwd: join(root, 'contracts'), encoding: 'utf8' });
      must(r.status === 0, 'cargo test failed');
      const passed = (r.stdout.match(/test result: ok\. (\d+) passed/g) ?? []).map((l) => Number(l.match(/(\d+) passed/)![1])).reduce((a, b) => a + b, 0);
      return `${passed} tests`;
    });
  }

  const depFile = join(root, `deployments/${network}.json`);
  const dep = existsSync(depFile) ? (JSON.parse(readFileSync(depFile, 'utf8')) as { commit: string; build: string; contracts: Record<string, { account: string; code_hash: string; crate: string }> }) : null;

  await check(`The contracts are deployed on ${network} and run the recorded code`, async () => {
    must(dep, `deployments/${network}.json is missing`);
    const lines: string[] = [];
    for (const [name, rec] of Object.entries(dep.contracts)) {
      const acct = await rpc<{ code_hash: string }>('query', { request_type: 'view_account', finality: 'final', account_id: rec.account });
      must(acct.code_hash === rec.code_hash, `${rec.account} runs ${acct.code_hash}, recorded ${rec.code_hash}`);
      lines.push(`${name} ${acct.code_hash.slice(0, 10)}`);
    }
    return lines.join(', ');
  });

  await check('The deployed code equals the reproducible build of the recorded commit (NEP-330)', async () => {
    must(dep, `deployments/${network}.json is missing`);
    must(dep.build === 'reproducible', `the recorded build is ${dep.build}, not reproducible`);
    const dir = join(root, 'contracts/target/near-reproducible', dep.commit);
    must(existsSync(dir), `no local reproducible build of ${dep.commit.slice(0, 12)}: run contracts/scripts/build.sh --reproducible ${dep.commit}`);
    for (const [name, rec] of Object.entries(dep.contracts)) {
      const crate = rec.crate.replace(/^attestra-/, '');
      const local = b58sha256(readFileSync(join(dir, `attestra_${crate}.wasm`)));
      must(local === rec.code_hash, `${name}: local build ${local} differs from ${rec.code_hash}`);
    }
    const meta = await c.view<{ link?: string; version?: string; build_info?: { source_code_snapshot?: string } }>(dep.contracts.attestations.account, 'contract_source_metadata');
    return `all ${Object.keys(dep.contracts).length} match; metadata ${meta?.build_info?.source_code_snapshot ?? meta?.link ?? 'present'}`;
  });

  await check('The well-known schemas are registered', async () => {
    for (const k of Object.keys(KNOWN_SCHEMAS) as Array<keyof typeof KNOWN_SCHEMAS>) {
      const s = await c.getSchema(knownSchemaUid(k));
      must(s.success && s.data?.status === 'active', `${k} is not registered`);
    }
    return `${Object.keys(KNOWN_SCHEMAS).length} schemas`;
  });

  await check('A recent attestation is proven final with a light client proof (checked locally)', async () => {
    const list = await idx.listAttestations({ limit: 1 });
    must(list.data[0], 'the indexer has no attestation');
    const p = await c.proveAttestation(list.data[0].uid);
    must(p.success && p.data?.verified, p.error?.message ?? `proof failed: ${JSON.stringify(p.data?.checks)}`);
    return `${list.data[0].uid.slice(0, 12)} in block ${p.data.block.height}, head approved by ${(Number((BigInt(p.data.head.approvedStake) * 1000n) / BigInt(p.data.head.totalStake)) / 10).toFixed(1)}% of stake`;
  });

  await check('An AI-checked attestation carries a valid enclave signature and NEAR AI model signature', async () => {
    const ev = await idx.listEvents({ event: 'verdict_accepted', limit: 5 });
    const hit = ev.data.find((e) => e.data.result === true);
    must(hit, 'no accepted AI verdict yet');
    const args = (await txArgs(hit.tx_hash, hit.signer_id)) as { verdict: AiVerdict; enclave_key: string; enclave_signature: string; nearai: { text: string; signature: string; algo: string; key: string } };
    const okEnclave = ed25519.verify(base64ToBytes(args.enclave_signature), verdictDigest(args.verdict), base58Decode(args.enclave_key.replace(/^ed25519:/, '')));
    must(okEnclave, 'the enclave signature does not verify');
    const cfg = await c.view<{ enclave_keys: string[] }>(c.contracts.verdicts, 'get_config');
    must(cfg?.enclave_keys.includes(args.enclave_key), 'the enclave key is not allowlisted by the verdicts contract');
    if (args.nearai.algo === 'ed25519') {
      const okModel = ed25519.verify(Buffer.from(args.nearai.signature, 'hex'), new TextEncoder().encode(args.nearai.text), Buffer.from(args.nearai.key, 'hex'));
      must(okModel, 'the NEAR AI signature does not verify');
    }
    must(args.nearai.text.includes(args.verdict.evidence_hash), 'the model signed a different request');
    return `${args.verdict.rule_id} for ${args.verdict.subject} by ${args.verdict.model}; enclave ${args.enclave_key.slice(0, 16)}...`;
  });

  await check('A cross-chain attestation was verified by the MPC network and its event is final', async () => {
    const ev = await idx.listEvents({ event: 'foreign_tx_verified', limit: 1 });
    must(ev.data[0], 'no verified foreign event yet');
    const e = ev.data[0];
    const att = await idx.listAttestations({ schema: knownSchemaUid('foreignEvent'), limit: 5 });
    must(att.data.some((a) => a.attester === c.contracts.verdicts), 'no cross-chain attestation by the verdicts contract');
    const receipt = await findEventReceipt(rpc, e.tx_hash, e.signer_id, (x) => x.event === 'foreign_tx_verified');
    must(receipt, 'event receipt not found');
    const p = await proveReceipt(rpc, { receiptId: receipt.receiptId, receiverId: receipt.executorId, expectedLog: receipt.log });
    must(p.verified, 'the light client proof failed');
    return `${String(e.data.chain)} tx ${String(e.data.tx_id).slice(0, 12)}..., final in block ${p.block.height}`;
  });

  await check("An agent's identity and reputation are on chain", async () => {
    const agents = await idx.listAgents({ limit: 10 });
    const a = agents.data.find((x) => x.identity && x.review_count > 0);
    must(a, 'no agent with an identity and a review yet');
    const onChain = await c.getAttestation(a.identity!.uid);
    must(onChain.success && onChain.data?.status === 'active', 'the identity attestation is not active on chain');
    const fields = new SchemaEncoder(KNOWN_SCHEMAS.agentIdentity.definition).decode(onChain.data.data);
    return `${a.account_id}: ${String(fields.name)} (${String(fields.model)}), ${a.review_count} reviews, average ${a.average_score}`;
  });

  await check('The indexer is caught up with the chain', async () => {
    const s = await idx.status();
    must(s.caught_up, `lag ${s.lag_blocks} blocks`);
    return `lag ${s.lag_blocks} blocks`;
  });

  await check('The site, llms.txt and the hosted MCP endpoint answer', async () => {
    const home = await fetch(SITE);
    must(home.ok, `${SITE} answered ${home.status}`);
    const llms = await fetch(`${SITE}/llms.txt`);
    must(llms.ok && (await llms.text()).includes('Attestra'), 'llms.txt is missing');
    const mcp = await fetch(`${SITE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = (await mcp.json()) as { result?: { tools: unknown[] } };
    must(body.result?.tools?.length, 'MCP tools/list failed');
    return `${SITE}, ${body.result.tools.length} MCP tools`;
  });

  await check('The services answer /live and /health', async () => {
    const out: string[] = [];
    for (const [name, url] of [['indexer', INDEXER], ['agent', AGENT], ['relayer', RELAYER], ['keeper', KEEPER], ['topup', TOPUP]]) {
      const live = await fetch(`${url}/live`).catch(() => null);
      must(live?.ok, `${name} at ${url} does not answer /live`);
      const h = (await (await fetch(`${url}/health`)).json()) as { ok: boolean; reason?: string };
      out.push(`${name} ${h.ok ? 'healthy' : `degraded (${h.reason})`}`);
    }
    return out.join('; ');
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  try {
    console.log(`commit ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()}`);
  } catch {
    // not a git checkout
  }
  process.exit(failed ? 1 : 0);
}

void main();

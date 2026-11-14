/**
 * pnpm verify: checks a live deployment and the stack around it, printing PASS or FAIL per check:
 * the test suites, the deployed code against the record and a local reproducible build, the
 * well-known schemas, a light client proof, an AI-checked and a cross-chain attestation, an agent's
 * reputation, the indexer's lag, and the site and service health.
 *
 *   pnpm verify                  everything (runs the test suites first)
 *   pnpm verify --skip-tests     only the live checks
 *
 * Env: SITE_URL (http://localhost:3100), INDEXER_URL (:5100), AGENT_URL (:5300), RELAYER_URL (:5200),
 * KEEPER_URL (:5400), TOPUP_URL (:5500), NEAR_NETWORK (testnet). Run the local stack first
 * (`pnpm dev` or `docker compose up`), or point the URLs at the hosted one.
 * The NEAR AI attestation check runs tools/nearai-verify with Node >= 24.22.1 (this node, NODE24, or
 * nvm's newest 24+) and needs NEARAI_API_KEY.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { verifySignature } from '../apps/agent/src/nearai';
import {
  AttestraClient,
  DEPLOYMENT_DAOS,
  IndexerClient,
  KNOWN_SCHEMAS,
  READ_TOOLS,
  SchemaEncoder,
  base58Decode,
  base58Encode,
  base64ToBytes,
  findEventReceipt,
  knownSchemaUid,
  proveReceipt,
  verdictDigest,
  type AgentProfile,
  type AiVerdict,
  type Network,
} from 'attestra';

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

/** A dropped connection or a rate limit (shared RPCs, a busy local stack) gets one more try before it counts. */
const transient = (e: unknown) => /fetch failed|not reachable|429|Too Many Requests|ECONNRESET|socket/i.test((e as Error).message ?? '');

async function check(claim: string, fn: () => Promise<string>) {
  try {
    const detail = await fn().catch(async (e) => {
      if (!transient(e)) throw e;
      await new Promise((r) => setTimeout(r, 3000));
      return fn();
    });
    results.push({ claim, ok: true, detail });
    console.log(`\u001b[32mPASS\u001b[0m ${claim}${detail ? `\n     ${detail}` : ''}`);
  } catch (e) {
    const msg = (e as Error).message === 'fetch failed' ? `the indexer at ${INDEXER} is not reachable: ${HINT}` : (e as Error).message;
    results.push({ claim, ok: false, detail: msg });
    console.log(`\u001b[31mFAIL\u001b[0m ${claim}\n     ${msg}`);
  }
}

const HINT = 'start the stack with `pnpm dev` (or `docker compose up`), or set SITE_URL, INDEXER_URL, AGENT_URL, RELAYER_URL, KEEPER_URL and TOPUP_URL';

/** fetch that names the URL it could not reach. */
async function get(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    throw new Error(`${url} is not reachable${cause ? ` (${cause})` : ''}: ${HINT}`);
  }
}

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function b58sha256(bytes: Buffer) {
  return base58Encode(createHash('sha256').update(bytes).digest());
}

/** The SDK's engines field: `@nearai/inference-sdk` needs Node >= 24.22.1. */
const NODE_MIN = [24, 22, 1];
const atLeastMin = (v: string) => {
  const p = v.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((p[i] ?? 0) !== NODE_MIN[i]) return (p[i] ?? 0) > NODE_MIN[i];
  return true;
};

/** A node binary new enough for the SDK: this one, NODE24, or the newest one nvm installed. */
function node24(): string | undefined {
  if (atLeastMin(process.versions.node)) return process.execPath;
  const env = process.env.NODE24;
  if (env) {
    const v = spawnSync(env, ['--version'], { encoding: 'utf8' });
    return v.status === 0 && atLeastMin(v.stdout.trim()) ? env : undefined;
  }
  const dir = join(process.env.NVM_DIR ?? join(homedir(), '.nvm'), 'versions/node');
  if (!existsSync(dir)) return undefined;
  const best = readdirSync(dir)
    .filter((v) => /^v\d+\.\d+\.\d+$/.test(v) && atLeastMin(v))
    .sort((a, b) => {
      const [x, y] = [a, b].map((v) => v.slice(1).split('.').map(Number));
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    })[0];
  return best && existsSync(join(dir, best, 'bin/node')) ? join(dir, best, 'bin/node') : undefined;
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

  await check('The private-check key is the OutLayer checker build\'s own key (TEE attestation binds it to the wasm hash)', async () => {
    const ck = (dep as { checker?: { wasm_hash: string; wasm_url: string; key: string; key_tx: string; key_tx_signer: string } } | null)?.checker;
    must(ck, `deployments/${network}.json has no checker record (scripts/outlayer-publish.ts writes it)`);
    // 1. The published bytes are the recorded build.
    const wasm = Buffer.from(await (await get(ck.wasm_url)).arrayBuffer());
    must(createHash('sha256').update(wasm).digest('hex') === ck.wasm_hash, `${ck.wasm_url} does not serve the recorded build`);
    // 2. OutLayer's TEE attestation of the key run names this build and the hash of its output.
    const api = network === 'mainnet' ? 'https://api.outlayer.ai' : 'https://testnet-api.outlayer.ai';
    const att = (await (await get(`${api}/attestations/by-tx/${ck.key_tx}`)).json()) as { executed_wasm_sha256?: string; output_hash?: string; tdx_quote?: string };
    must(att.executed_wasm_sha256 === ck.wasm_hash, `the run's attestation names wasm ${att.executed_wasm_sha256}, not the recorded build`);
    must(att.tdx_quote, 'the run has no TDX quote');
    // 3. The run's output, read from the chain, has that hash and is the key.
    const out = await rpc<{ status: { SuccessValue?: string } }>('EXPERIMENTAL_tx_status', { tx_hash: ck.key_tx, sender_account_id: ck.key_tx_signer, wait_until: 'NONE' });
    const output = Buffer.from(out.status.SuccessValue ?? '', 'base64');
    must(createHash('sha256').update(output).digest('hex') === att.output_hash, 'the run\'s output does not match its attested hash');
    must((JSON.parse(output.toString()) as { enclaveKey?: string }).enclaveKey === ck.key, 'the attested output is not the recorded key');
    // 4. The verdicts contract trusts that key, and only it.
    const cfg = await c.view<{ enclave_keys: string[] }>(c.contracts.verdicts, 'get_config');
    must(cfg?.enclave_keys.includes(ck.key), 'the verdicts contract does not allowlist the checker key');
    const local = join(root, 'checker/target/outlayer/attestra-checker.wasm');
    const sameAsLocal = existsSync(local) && createHash('sha256').update(readFileSync(local)).digest('hex') === ck.wasm_hash;
    return `wasm ${ck.wasm_hash.slice(0, 12)}... on FastFS${sameAsLocal ? ', equal to the local reproducible build' : ''}; key ${ck.key.slice(0, 20)}... from a TDX-attested run; allowlisted${cfg.enclave_keys.length === 1 ? ' (the only key)' : ` with ${cfg.enclave_keys.length - 1} other key(s)`}`;
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
    // ed25519 against the model key, or ecdsa (EIP-191) recovering the model's address, as the contract does.
    const okModel = verifySignature({ text: args.nearai.text, signature: args.nearai.signature, signing_algo: args.nearai.algo as 'ecdsa' | 'ed25519', signing_address: args.nearai.key }, args.nearai.algo === 'ed25519' ? { ed25519: args.nearai.key } : { address: args.nearai.key });
    must(okModel, `the NEAR AI ${args.nearai.algo} signature does not verify`);
    must(args.nearai.text.includes(args.verdict.evidence_hash), 'the model signed a different request');
    return `${args.verdict.rule_id} for ${args.verdict.subject} by ${args.verdict.model}; enclave ${args.enclave_key.slice(0, 16)}...`;
  });

  await check('The NEAR AI model key the verdicts contract trusts is attested by its TEE (verified with @nearai/inference-sdk)', async () => {
    const dir = join(root, 'tools/nearai-verify');
    const setup = 'with Node 24 run `pnpm install && pnpm build` in tools/nearai-verify';
    const node = node24();
    must(node, `@nearai/inference-sdk needs Node >= ${NODE_MIN.join('.')}: install it (\`nvm install 24\`) or set NODE24 to a node 24 binary`);
    must(existsSync(join(dir, 'node_modules/@nearai/inference-sdk')) && existsSync(join(dir, 'dist/index.js')), `the verifier is not installed: ${setup}`);
    must(process.env.NEARAI_API_KEY, 'NEARAI_API_KEY is not set: the SDK fetches model reports with a NEAR AI Cloud key (any key from cloud.near.ai or nearbuilders.org; reading reports spends no credits)');
    const r = spawnSync(node, [join(dir, 'dist/index.js'), '--contract', c.contracts.verdicts, '--rpc', c.config.rpcUrls[0], '--json'], { cwd: dir, encoding: 'utf8', timeout: 180_000 });
    let out: { ok: boolean; sdk?: string; error?: { message: string }; reports?: Array<{ model: string; ok: boolean; error?: { message: string; code?: string }; gateway?: { tcbStatus: string; tlsBinding: string }; signers: Array<{ key: string; tcbStatus: string; gpuEvidence: string }>; trusted?: { key: string; attested: boolean } }> };
    try {
      out = JSON.parse(r.stdout);
    } catch {
      throw new Error(`the verifier did not answer with JSON (status ${r.status ?? r.signal}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
    }
    const reports = out.reports ?? [];
    const failed = reports.find((x) => !x.ok);
    must(out.ok && reports.length, out.error?.message ?? (failed ? `${failed.model}: ${failed.error?.message ?? 'not verified'}` : 'no model signer checked'));
    return reports
      .map((x) => {
        const s = x.signers.find((y) => y.key === x.trusted?.key) ?? x.signers[0];
        return `${x.model}: key ${x.trusted!.key.slice(0, 16)}... in a TDX report (TCB ${s.tcbStatus}), GPU evidence ${s.gpuEvidence}; Gateway TCB ${x.gateway?.tcbStatus}, TLS ${x.gateway?.tlsBinding.split(':')[0]}; SDK ${out.sdk ?? '?'}`;
      })
      .join('; ');
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
    const agents = await idx.listAgents({ limit: 20 });
    // The SDK runs the reputation rules itself and reads every claimed payment from the chain.
    const profiles: AgentProfile[] = [];
    for (const x of agents.data) {
      const p = await c.getAgentProfile(x.account_id);
      must(p.success && p.data, `${x.account_id}: ${p.error?.message ?? 'no profile'}`);
      profiles.push(p.data);
    }
    const verified = profiles.filter((p) => p.identity_status === 'verified');
    const unverified = profiles.filter((p) => p.identity_status === 'unverified').length;
    must(verified.length, `no agent with a verified identity among ${profiles.length} (${unverified} unverified: the attester is neither the agent account nor its parent)`);
    const a = verified.find((p) => p.paid_review_count > 0) ?? verified.find((p) => p.review_count > 0) ?? verified[0];
    const onChain = await c.getAttestation(a.identity!.uid);
    must(onChain.success && onChain.data?.status === 'active', 'the identity attestation is not active on chain');
    must(onChain.data.attester === a.identity!.attester, 'the identity attester differs from the chain');
    const fields = new SchemaEncoder(KNOWN_SCHEMAS.agentIdentity.definition).decode(onChain.data.data);
    const paid = a.paid_review_count > 0 ? `${a.paid_review_count} paid (average ${a.paid_average_score})` : 'no paid review yet';
    const excluded = Object.entries(a.excluded_reasons).map(([k, n]) => `${n} ${k}`).join(', ');
    return (
      `${a.account_id}: ${String(fields.name)} (${String(fields.model)}), identity verified (registered by ${onChain.data.attester}), ` +
      `${a.review_count} counted reviews${a.average_score !== null ? ` (average ${a.average_score})` : ''}, ${paid}${excluded ? `, not counted: ${excluded}` : ''}, ` +
      `${a.trusted ? 'trusted' : `not trusted (${a.trust_reasons.join('; ')})`}; ${verified.length} of ${profiles.length} agents have a verified identity, ${unverified} unverified`
    );
  });

  await check('A Sputnik DAO issued an attestation by proposal and council vote', async () => {
    const dao = DEPLOYMENT_DAOS[network];
    must(dao, `no deployment DAO on ${network}`);
    const issued = await idx.listAttestations({ attester: dao, schema: knownSchemaUid('membership'), limit: 20 });
    must(issued.data.length, `no attestation by ${dao} yet`);
    const proposals = await c.getDaoProposals(dao, { limit: 100 });
    must(proposals.success && proposals.data, proposals.error?.message ?? 'the DAO did not answer');
    for (const a of issued.data) {
      const onChain = await c.getAttestation(a.uid);
      if (!onChain.success || onChain.data?.attester !== dao) continue;
      const p = proposals.data.find((x) => x.status === 'Approved' && x.call?.method === 'attest' && x.call.subject === a.subject && x.call.data === onChain.data!.data);
      if (!p) continue;
      const fields = new SchemaEncoder(KNOWN_SCHEMAS.membership.definition).decode(onChain.data.data);
      return `${a.uid.slice(0, 12)}... by ${dao}: ${a.subject} as ${String(fields.role)}, proposal #${p.id} approved by ${Object.keys(p.votes).join(', ')}`;
    }
    throw new Error(`no attestation by ${dao} matches an approved proposal among its latest 100`);
  });

  await check('The indexer is caught up with the chain', async () => {
    const s = await idx.status();
    must(s.caught_up, `lag ${s.lag_blocks} blocks`);
    return `lag ${s.lag_blocks} blocks`;
  });

  await check('The site, llms.txt and the hosted MCP endpoint answer', async () => {
    const home = await get(SITE);
    must(home.ok, `${SITE} answered ${home.status}`);
    const llms = await get(`${SITE}/llms.txt`);
    must(llms.ok && (await llms.text()).includes('Attestra'), 'llms.txt is missing');
    const mcp = await get(`${SITE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = (await mcp.json()) as { result?: { tools: unknown[] } };
    must(body.result?.tools?.length, 'MCP tools/list failed');
    return `${SITE}, ${body.result.tools.length} MCP tools`;
  });

  await check('Every hosted MCP tool answers with live data', async () => {
    const att = (await idx.listAttestations({ limit: 1 })).data[0];
    must(att, 'the indexer has no attestation');
    const authority = (await idx.listAuthorities({ limit: 1 })).data[0]?.account_id ?? c.config.root;
    const agent = (await idx.listAgents({ limit: 1 })).data[0]?.account_id;
    const args: Record<string, Record<string, unknown>> = {
      well_known_schemas: {},
      get_schema: { uid: att.schema_uid },
      list_schemas: { limit: 3 },
      get_attestation: { uid: att.uid },
      verify_attestation: { uid: att.uid },
      list_attestations: { limit: 3 },
      get_authority: { account_id: authority },
      get_delegates: { authority },
      get_agent_reputation: { agent: agent ?? `agent.${c.config.root}` },
      prove_attestation: { uid: att.uid },
      decode_data: { definition: 'string name, u8 level', data: 'AwAAAEJvYgM=' },
      compute_schema_uid: { definition: 'string name, u8 level', revocable: true },
      linked_account: { caip10: `eip155:1:0x${'0'.repeat(40)}` },
      wallet_link_message: { account_id: c.config.root, chain: 'eip155', address: `0x${'0'.repeat(40)}` },
      list_agent_keys: { account_id: c.config.root },
      list_dao_proposals: { limit: 2 },
    };
    // Every read tool the SDK defines is called, so a new tool cannot slip past this check.
    const missing = READ_TOOLS.filter((t) => !(t in args));
    must(!missing.length, `no live arguments for ${missing.join(', ')}`);
    const failed: string[] = [];
    for (const [name, a] of Object.entries(args)) {
      const res = await get(`${SITE}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a } }),
      });
      const r = (await res.json()) as { result?: { isError?: boolean } };
      if (!r.result || r.result.isError) failed.push(name);
    }
    must(!failed.length, `failed: ${failed.join(', ')}`);
    return `${Object.keys(args).length} tools`;
  });

  await check('The services answer /live and /health', async () => {
    const out: string[] = [];
    for (const [name, url] of [['indexer', INDEXER], ['agent', AGENT], ['relayer', RELAYER], ['keeper', KEEPER], ['topup', TOPUP]]) {
      const live = await fetch(`${url}/live`).catch(() => null);
      must(live?.ok, `${name} at ${url} does not answer /live`);
      const h = (await (await get(`${url}/health`)).json()) as { ok: boolean; reason?: string };
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

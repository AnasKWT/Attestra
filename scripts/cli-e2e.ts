/**
 * Drives the built `attestra` CLI through every command group that needs only the chain and prints
 * PASS or FAIL per step. Groups that need the indexer, the agent or NEAR AI (lists, profile, events
 * list, check run, pay, ai) are covered by their own suites and by `pnpm verify` on testnet.
 *
 *   pnpm build && contracts/scripts/build.sh && pnpm cli:e2e     a fresh local sandbox (scripts/deploy.ts sandbox)
 *   pnpm cli:e2e testnet                                           the testnet deployment, signed by its root from the
 *                                                                  NEAR CLI keychain; the run's accounts are deleted back
 *                                                                  into the root at the end and its schemas carry a run tag
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { InMemoryKeyStore, Near, generateKey } from 'near-kit';
import { FileKeyStore } from 'near-kit/keys/file';
import { homedir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repo, 'packages/cli/dist/index.js');
const work = mkdtempSync(join(tmpdir(), 'attestra-cli-e2e-'));
const holdFile = join(work, 'sandbox.json');
const TESTNET = process.argv[2] === 'testnet';
// Schema uids are global, so a testnet run adds a field named after the run to every schema it registers.
const tag = TESTNET ? `r${Date.now().toString(36)}` : '';
const D = (def: string) => (tag ? `${def}, bool ${tag}` : def);
const V = (v: object) => JSON.stringify(tag ? { ...v, [tag]: true } : v);

type Json = { success: boolean; data?: any; error?: { type: string; message: string }; tx_hash?: string };
const results: { step: string; ok: boolean; detail?: string }[] = [];

async function main() {
  if (!existsSync(cli)) throw new Error('build the CLI first: pnpm build');
  if (TESTNET) return testnet();
  const deploy = spawn('npx', ['tsx', 'scripts/deploy.ts', 'sandbox'], { cwd: repo, env: { ...process.env, HOLD: holdFile }, stdio: ['ignore', 'pipe', 'inherit'] });
  deploy.stdout.on('data', (b: Buffer) => process.stdout.write(`  deploy | ${b.toString()}`.replace(/\n(?!$)/g, '\n  deploy | ')));
  const exited = new Promise<number | null>((r) => deploy.on('exit', r));
  try {
    while (!existsSync(holdFile)) {
      if (deploy.exitCode !== null) throw new Error('the sandbox deploy failed');
      await new Promise((r) => setTimeout(r, 500));
    }
    await scenario(JSON.parse(readFileSync(holdFile, 'utf8')));
  } finally {
    deploy.kill('SIGTERM');
    await exited;
    rmSync(work, { recursive: true, force: true });
  }
  report();
}

function report() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) process.exit(1);
}

async function testnet() {
  const root = process.env.ROOT ?? 'attestra.testnet';
  const rpcUrl = process.env.RPC_URL ?? 'https://rpc.testnet.fastnear.com';
  const secret = (await new FileKeyStore(join(homedir(), '.near-credentials'), 'testnet').get(root))?.secretKey;
  if (!secret) throw new Error(`no key for ${root} in ~/.near-credentials/testnet`);
  try {
    await scenario({ rpcUrl, root, rootSecret: secret, networkId: 'testnet', prefix: `${tag}-`, fund: '1.5 NEAR' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  report();
}

type Env = { rpcUrl: string; root: string; rootSecret: string; networkId?: string; prefix?: string; fund?: `${number} NEAR` };

async function scenario(env: Env) {
  const keyStore = new InMemoryKeyStore({ [env.root]: env.rootSecret });
  const near = new Near({ network: { rpcUrl: env.rpcUrl, networkId: env.networkId ?? 'sandbox' }, keyStore });
  const keys: Record<string, string> = {};
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => `${env.prefix ?? ''}${n}.${env.root}`);
  for (const id of [alice, bob, carol]) {
    const k = generateKey();
    await keyStore.add(id, k);
    await near.transaction(env.root).createAccount(id).transfer(id, env.fund ?? '30 NEAR').addKey(k.publicKey.toString(), { type: 'fullAccess' }).send();
    keys[id] = k.secretKey;
  }
  try {
    await steps(env, keys, alice, bob, carol);
  } finally {
    // On testnet the run's accounts go back into the root; a sandbox is thrown away whole.
    if (env.networkId === 'testnet') {
      for (const id of [alice, bob, carol]) {
        await near.transaction(id).deleteAccount({ beneficiary: env.root }).send().catch((e: Error) => console.log(`  could not delete ${id}: ${e.message}`));
      }
    }
  }
}

async function steps(env: Env, keys: Record<string, string>, alice: string, bob: string, carol: string) {
  const ids = {
    whitelist: `whitelist.${env.root}`,
    fee: `fee.${env.root}`,
    gated: `gated.${env.root}`,
    reward: `reward.${env.root}`,
    pipeline: `pipeline.${env.root}`,
    token: `token.${env.root}`,
  };

  // On testnet the groups that read the indexer or call the agent run too, against the local stack.
  const services = env.networkId === 'testnet';
  const run = (args: string[], as?: string, key?: string): Json => {
    const r = spawnSync('node', [cli, '--json', '--rpc', env.rpcUrl, '--root', env.root, ...(as ? ['-a', as] : []), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ATTESTRA_PRIVATE_KEY: key ?? (as ? keys[as] : ''),
        ATTESTRA_INDEXER_URL: services ? INDEXER : 'http://127.0.0.1:9',
        ATTESTRA_AGENT_URL: services ? AGENT : 'http://127.0.0.1:9',
      },
    });
    try {
      return JSON.parse(r.stdout || r.stderr) as Json;
    } catch {
      return { success: false, error: { type: 'PARSE', message: (r.stdout + r.stderr).slice(0, 300) } };
    }
  };
  const step = (name: string, res: Json, check: (d: any) => boolean = () => true): any => {
    const ok = res.success && check(res.data);
    results.push({ step: name, ok, detail: ok ? undefined : JSON.stringify(res.error ?? res.data).slice(0, 300) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${JSON.stringify(res.error ?? res.data).slice(0, 300)}`}`);
    return res.data;
  };
  const refused = (name: string, res: Json, type?: string) => {
    const ok = !res.success && (!type || res.error?.type === type);
    results.push({ step: name, ok, detail: ok ? undefined : JSON.stringify(res) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected a refusal${type ? ` (${type})` : ''}, got ${JSON.stringify(res).slice(0, 300)}`}`);
  };

  // schema
  const def = 'string name, u8 level';
  const s = step('schema create', run(['schema', 'create', '-d', D(def), '--revocable'], alice), (d) => /^[0-9a-f]{64}$/.test(d.schemaUid)).schemaUid;
  step('schema fetch', run(['schema', 'fetch', s]), (d) => d.definition === D(def) && d.authority === alice);
  step('schema uid matches the chain', run(['schema', 'uid', '-d', D(def), '--revocable']), (d) => d.uid === s);
  step('schema known', run(['schema', 'known']), (d) => Array.isArray(d) && d.length >= 6);

  // blob (large schema)
  const big = join(work, 'big.txt');
  writeFileSync(big, D(Array.from({ length: 40 }, (_, i) => `string field_${i}`).join(', ')));
  const blob = step('blob store', run(['blob', 'store', '-f', big], alice), (d) => /^[0-9a-f]{64}$/.test(d.blobHash)).blobHash;
  step('blob fetch', run(['blob', 'fetch', blob]), (d) => d.definition.includes('field_39'));
  step('blob register', run(['blob', 'register', blob, '--revocable'], alice), (d) => /^[0-9a-f]{64}$/.test(d.schemaUid));

  // attestation
  const a1 = step('attestation create', run(['attestation', 'create', '-s', s, '--subject', bob, '-v', V({"name":"Bob","level":3})], alice), (d) => d.status === 'created').attestationUid;
  step('attestation fetch decodes data', run(['attestation', 'fetch', a1]), (d) => JSON.stringify(d).includes('Bob'));
  step('attestation verify', run(['attestation', 'verify', a1]), (d) => d.valid === true);
  refused('attestation revoke by a stranger', run(['attestation', 'revoke', a1], carol));

  // authority and storage
  step('authority register', run(['authority', 'register', '-m', 'Alice Labs', '-k', 'organization'], alice));
  step('authority fetch', run(['authority', 'fetch', alice]), (d) => JSON.stringify(d).includes('Alice Labs'));
  step('storage balance', run(['storage', 'balance', 'attestations', alice]), (d) => d !== null);
  step('storage deposit', run(['storage', 'deposit', 'attestations', '100000000000000000000000'], alice));

  // delegation
  step('delegate add', run(['delegate', 'add', bob, '--schemas', s, '--max-uses', '2', '--can-revoke'], alice));
  step('delegate check', run(['delegate', 'check', alice, bob]), (d) => d === true || d?.isDelegate === true || d?.delegate === true);
  step('delegate list', run(['delegate', 'list', alice]), (d) => JSON.stringify(d).includes(bob));
  const a2 = step('delegate attest', run(['delegate', 'attest', '--authority', alice, '-s', s, '--subject', carol, '-v', V({"name":"Carol","level":1})], bob), (d) => d.status === 'created').attestationUid;
  step('delegate revoke', run(['delegate', 'revoke', a2], bob));
  step('delegate remove', run(['delegate', 'remove', bob], alice));
  refused('delegate attest after removal', run(['delegate', 'attest', '--authority', alice, '-s', s, '--subject', carol, '-v', V({"name":"Carol","level":1})], bob));

  // whitelist resolver
  const sw = step('whitelist schema', run(['schema', 'create', '-d', D('bool member'), '--revocable', '-r', ids.whitelist], alice), (d) => d.schemaUid).schemaUid;
  step('whitelist add', run(['whitelist', 'add', sw, bob], alice));
  step('whitelist check', run(['whitelist', 'check', sw, bob]), (d) => d === true || d?.whitelisted === true);
  step('whitelist info', run(['whitelist', 'info']));
  step('whitelisted attester is accepted', run(['attestation', 'create', '-s', sw, '--subject', alice, '-v', V({"member":true})], bob), (d) => d.status === 'created');
  refused('other attester is refused by the resolver', run(['attestation', 'create', '-s', sw, '--subject', alice, '-v', V({"member":true})], carol));
  step('whitelist remove', run(['whitelist', 'remove', sw, bob], alice));

  // test token and staking
  step('token faucet', run(['token', 'faucet'], alice));
  step('token balance', run(['token', 'balance', alice]), (d) => BigInt(d.balance ?? d) > 0n);
  step('staking tiers', run(['staking', 'tiers']));
  step('staking stake', run(['staking', 'stake', '1000000000000000000'], alice));
  step('staking info', run(['staking', 'info', alice]), (d) => JSON.stringify(d).includes('1000000000000000000'));
  step('staking unstake', run(['staking', 'unstake', '1000000000000000000'], alice));

  // fee resolver (NEAR)
  const sf = step('fee schema', run(['schema', 'create', '-d', D('string note'), '--revocable', '-r', ids.fee], alice), (d) => d.schemaUid).schemaUid;
  step('fee set-fee', run(['fee', 'set-fee', sf, '10000000000000000000000'], alice));
  step('fee get-fee', run(['fee', 'get-fee', sf]), (d) => JSON.stringify(d).includes('10000000000000000000000'));
  refused('attest without a prepaid fee is refused', run(['attestation', 'create', '-s', sf, '--subject', bob, '-v', V({"note":"x"})], carol));
  step('fee deposit', run(['fee', 'deposit', '20000000000000000000000'], carol));
  step('fee balance', run(['fee', 'balance', carol]), (d) => JSON.stringify(d).includes('20000000000000000000000'));
  step('paid attestation is accepted', run(['attestation', 'create', '-s', sf, '--subject', bob, '-v', V({"note":"paid"})], carol), (d) => d.status === 'created');
  step('fee collected', run(['fee', 'collected', sf]), (d) => JSON.stringify(d).includes('10000000000000000000000'));
  step('fee withdraw', run(['fee', 'withdraw', sf], alice));
  step('fee refund', run(['fee', 'refund'], carol));

  // token gate and token reward
  const sg = step('token-gated schema', run(['schema', 'create', '-d', D('string note'), '-r', ids.gated], alice), (d) => d.schemaUid).schemaUid;
  step('token-gated set-config', run(['token-gated', 'set-config', sg, ids.token, '1'], alice));
  step('token-gated get-config', run(['token-gated', 'get-config', sg]), (d) => JSON.stringify(d).includes(ids.token));
  step('token holder passes the gate', run(['attestation', 'create', '-s', sg, '--subject', bob, '-v', V({"note":"holder"})], alice), (d) => d.status === 'created');
  refused('account without tokens is refused', run(['attestation', 'create', '-s', sg, '--subject', bob, '-v', V({"note":"none"})], carol));
  const sr = step('token-reward schema', run(['schema', 'create', '-d', D('string note'), '-r', ids.reward], alice), (d) => d.schemaUid).schemaUid;
  step('token-reward set-config', run(['token-reward', 'set-config', sr, ids.token, '5'], alice));
  step('token-reward fund', run(['token-reward', 'fund', sr, ids.token, '100'], alice));
  step('token-reward get-config', run(['token-reward', 'get-config', sr]), (d) => JSON.stringify(d).includes(ids.token));
  step('rewarded attestation', run(['attestation', 'create', '-s', sr, '--subject', bob, '-v', V({"note":"thanks"})], alice), (d) => d.status === 'created');
  step('token-reward distributed', run(['token-reward', 'distributed', sr, bob]), (d) => JSON.stringify(d).includes('5'));

  // pipeline
  const sp = step('pipeline schema', run(['schema', 'create', '-d', D('string note'), '--revocable', '-r', ids.pipeline], alice), (d) => d.schemaUid).schemaUid;
  step('pipeline set', run(['pipeline', 'set', sp, ids.whitelist], alice));
  step('pipeline get', run(['pipeline', 'get', sp]), (d) => JSON.stringify(d).includes(ids.whitelist));
  step('whitelist add through the pipeline schema', run(['whitelist', 'add', sp, alice], alice));
  step('pipeline accepts a whitelisted attester', run(['attestation', 'create', '-s', sp, '--subject', bob, '-v', V({"note":"ok"})], alice), (d) => d.status === 'created');
  refused('pipeline refuses another attester', run(['attestation', 'create', '-s', sp, '--subject', bob, '-v', V({"note":"no"})], carol));

  // credentials
  const a3 = step('attestation for a credential', run(['attestation', 'create', '-s', s, '--subject', bob, '-v', V({"name":"Bob","level":5})], alice), (d) => d.status === 'created').attestationUid;
  step('credential mint (subject)', run(['credential', 'mint', a3], bob));
  step('credential fetch', run(['credential', 'fetch', a3]), (d) => JSON.stringify(d).includes(bob));
  step('credential list', run(['credential', 'list', bob]), (d) => JSON.stringify(d).includes(a3));
  step('attestation revoke', run(['attestation', 'revoke', a3], alice));
  step('attestation no longer valid', run(['attestation', 'verify', a3]), (d) => d.valid === false);
  await waitFor(() => { const r = run(['credential', 'fetch', a3]); return r.success && r.data === null; }, 'credential burned');

  // scheduled revocation
  const a4 = step('attestation to schedule', run(['attestation', 'create', '-s', s, '--subject', carol, '-v', V({"name":"Carol","level":2})], alice), (d) => d.status === 'created').attestationUid;
  step('schedule revoke', run(['schedule', 'revoke', a4, '--in', '4'], alice));
  step('schedule status', run(['schedule', 'status', a4]), (d) => d !== null);
  await waitFor(() => run(['attestation', 'verify', a4]).data?.valid === false, 'scheduled revocation takes effect');
  step('schedule finalize', run(['schedule', 'finalize', a4], carol));

  // multisig
  const ms = step('multisig create', run(['multisig', 'create', '--members', `${alice},${bob},${carol}`, '--threshold', '2', '-m', 'Council'], alice), (d) => d.multisigId).multisigId;
  step('multisig fetch', run(['multisig', 'fetch', ms]), (d) => d.threshold === 2);
  const sm = step('schema for the multisig', run(['schema', 'create', '-d', D('string decision'), '--revocable'], alice), (d) => d.schemaUid).schemaUid;
  const pid = step('multisig propose-attest', run(['multisig', 'propose-attest', ms, '-s', sm, '--subject', bob, '-v', V({"decision":"approved"})], alice), (d) => typeof d.proposalId === 'number').proposalId;
  step('multisig proposal', run(['multisig', 'proposal', String(pid)]), (d) => d !== null);
  step('multisig approve reaches the threshold', run(['multisig', 'approve', String(pid)], bob));
  step('multisig proposal executed', run(['multisig', 'proposal', String(pid)]), (d) => JSON.stringify(d).toLowerCase().includes('execut'));

  // wallet link (Ethereum personal_sign)
  const sk = secp256k1.utils.randomSecretKey();
  const address = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(sk, false).slice(1)).slice(-20)).toString('hex')}`;
  const message = step('chain link-message', run(['chain', 'link-message', 'eip155', address], bob), (d) => d.message.includes(bob)).message as string;
  const text = new TextEncoder().encode(message);
  const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${text.length}`), ...text]));
  const rec = secp256k1.sign(digest, sk, { prehash: false, format: 'recovered' });
  const signature = Buffer.from([...rec.slice(1), 27 + rec[0]]).toString('hex');
  step('chain link', run(['chain', 'link', 'eip155', address, signature], bob));
  step('chain linked', run(['chain', 'linked', `eip155:1:${address}`]), (d) => JSON.stringify(d).includes(bob));
  refused('chain link with a wrong signature', run(['chain', 'link', 'eip155', address, `${signature.slice(0, -4)}0000`], carol));

  // Know Your Agent
  const agentAcct = `agent.${carol}`;
  step('agent register', run(['agent', 'register', agentAcct, '--name', 'Scout', '--model', 'z-ai/glm-5.3-flash', '--capabilities', 'search,verify'], carol));
  step('agent delegate', run(['agent', 'delegate', agentAcct, '--max-uses', '3'], carol));
  step('agent rate', run(['agent', 'rate', agentAcct, '5', '--comment', 'fast and correct'], alice));

  // an agent's function-call key: attest as the account, then lose the power when it is revoked
  const agentKey = generateKey();
  const agentPub = agentKey.publicKey.toString();
  step('agent grant-key', run(['agent', 'grant-key', agentPub, '--allowance', '0.5'], alice), (d) => d.publicKey === agentPub && d.methodNames.includes('attest'));
  step('agent keys', run(['agent', 'keys', alice]), (d) => JSON.stringify(d).includes(agentPub));
  step('the agent attests with its key', run(['attestation', 'create', '-s', s, '--subject', carol, '-v', V({ name: 'Carol', level: 4 })], alice, agentKey.secretKey), (d) => d.status === 'created');
  step('agent revoke-key', run(['agent', 'revoke-key', agentPub], alice));
  refused('the revoked key no longer signs', run(['attestation', 'create', '-s', s, '--subject', carol, '-v', V({ name: 'Carol', level: 5 })], alice, agentKey.secretKey));

  if (services) await serviceSteps(run, step, refused, { alice, a1, s, agent: agentAcct });

  // data helpers
  const enc = step('encode', run(['encode', def, '{"name":"Dan","level":7}']), (d) => typeof (d.data ?? d) === 'string');
  step('decode round-trips', run(['decode', def, enc.data ?? enc]), (d) => JSON.stringify(d).includes('Dan'));
}

const INDEXER = process.env.INDEXER_URL ?? 'http://localhost:5100';
const AGENT = process.env.AGENT_URL ?? 'http://localhost:5300';

type Run = (args: string[], as?: string, key?: string) => Json;

/** The groups that need the indexer, the agent or NEAR AI, against the stack running on testnet (`pnpm dev`). */
async function serviceSteps(
  run: Run,
  step: (name: string, res: Json, check?: (d: any) => boolean) => any,
  refused: (name: string, res: Json, type?: string) => void,
  t: { alice: string; a1: string; s: string; agent: string },
) {
  await waitFor(() => JSON.stringify(run(['attestation', 'list', '--attester', t.alice]).data ?? '').includes(t.a1), 'the indexer has the run', 120_000);
  step('attestation list', run(['attestation', 'list', '--attester', t.alice]), (d) => JSON.stringify(d).includes(t.a1));
  step('schema list', run(['schema', 'list', '--authority', t.alice]), (d) => JSON.stringify(d).includes(t.s));
  step('events list', run(['events', 'list', '--uid', t.a1]), (d) => JSON.stringify(d).includes('attestation_created'));
  step('events prove', run(['events', 'prove', t.a1]), (d) => d.verified === true);
  step('profile', run(['profile', t.alice]), (d) => JSON.stringify(d).includes(t.a1));
  step('agent profile', run(['agent', 'profile', t.agent]), (d) => JSON.stringify(d).includes(t.agent));
  step('check rules', run(['check', 'rules']), (d) => JSON.stringify(d).includes('age_over_18'));
  step('check run (NEAR AI, encrypted evidence)', run(['check', 'run', 'age_over_18', '--subject', t.alice, '--evidence', 'State ID card. Name: Test Person. Date of birth: 1990-04-12.']), (d) => d.outcome?.status === 'created' && d.verdict?.result === true);
  step('pay verify-claim (x402)', run(['pay', 'verify-claim', t.a1], t.alice), (d) => d.settlement?.success === true && d.result?.valid === true);
  step('pay verify-agent (x402)', run(['pay', 'verify-agent', t.agent], t.alice), (d) => d.settlement?.success === true);
  step('ai (NEAR AI chat with tools)', run(['ai', `Is attestation ${t.a1} valid? Answer yes or no.`]), (d) => typeof (d.reply ?? d) === 'string');
  refused('check run with an unknown rule', run(['check', 'run', 'no_such_rule', '--subject', t.alice, '--evidence', 'x']));
  const sol = await solanaInstruction();
  if (sol) step('chain attest-solana (MPC)', run(['chain', 'attest-solana', '--tx', sol.signature, '--instruction', String(sol.index), '--inner', '0'], t.alice), (d) => d.status === 'created');
  else results.push({ step: 'chain attest-solana (MPC)', ok: false, detail: 'no finalized devnet transaction with inner instructions found' });
}

/** A recent finalized devnet transaction of the associated token account program, which always makes inner calls. */
async function solanaInstruction(): Promise<{ signature: string; index: number } | null> {
  const call = async (method: string, params: unknown[]) =>
    ((await (await fetch('https://api.devnet.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: any }).result;
  const sigs = (await call('getSignaturesForAddress', ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', { limit: 20, commitment: 'finalized' }])) as Array<{ signature: string; err: unknown }>;
  for (const s of sigs ?? []) {
    if (s.err) continue;
    const tx = await call('getTransaction', [s.signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }]);
    const g = tx?.meta?.innerInstructions?.[0];
    if (g?.instructions?.length) return { signature: s.signature, index: g.index };
  }
  return null;
}

async function waitFor(fn: () => boolean, name: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) {
      results.push({ step: name, ok: true });
      console.log(`PASS  ${name}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  results.push({ step: name, ok: false, detail: 'timed out' });
  console.log(`FAIL  ${name} (timed out)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

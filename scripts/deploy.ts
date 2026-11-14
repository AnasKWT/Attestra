/**
 * Deploys and wires every Attestra contract, then writes deployments/<network>.json.
 * Idempotent: existing accounts are kept, initialized contracts are not re-initialized, and
 * configuration steps run only when the chain differs from the plan.
 *
 *   tsx scripts/deploy.ts sandbox                    a local sandbox node (rehearsal; writes .data/deployments/sandbox.json)
 *   REHEARSE=mainnet BUILD=<commit> tsx scripts/deploy.ts sandbox
 *                                                    the mainnet code paths on a local node: reproducible wasm only, no faucet
 *                                                    token, a stand-in NEP-141 for USDC and staking (.data/deployments/sandbox-mainnet.json)
 *   BUILD=<commit> tsx scripts/deploy.ts testnet     the reproducible build of <commit> (target/near-reproducible/<commit>)
 *   UPGRADE=1 BUILD=<commit> tsx scripts/deploy.ts testnet   also redeploy code that changed (state is kept)
 *   tsx scripts/deploy.ts mainnet                    #mainnet: refuses unless ATTESTRA_MAINNET_GO=<root> (an explicit go)
 *
 * Keys: the root account's key comes from the NEAR CLI keychain (~/.near-credentials/<network>/<root>.json);
 * every sub-account gets a fresh full-access key saved there too.
 * Optional env: ATTESTRA_ROOT (or ROOT), RPC_URL, ENCLAVE_PUBLIC_KEY (ed25519:...), MODEL_SIGNERS (JSON list), GOVERNANCE.
 * HOLD=<file> (sandbox only): keep the node running after the deploy and write its RPC URL and the root's
 * test key to <file> for other scripts (scripts/cli-e2e.ts); stops on SIGTERM or SIGINT.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryKeyStore, Near, generateKey, parseKey } from 'near-kit';
import { FileKeyStore } from 'near-kit/keys/file';
import { Sandbox } from 'near-kit/sandbox';
import { DEFAULT_ROOTS, KNOWN_SCHEMAS, base58Encode, contractIdsFor, knownSchemaUid, resolveNetwork } from 'attestra';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const NET = (process.argv[2] ?? 'testnet') as 'testnet' | 'mainnet' | 'sandbox';
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

// #mainnet: true on mainnet and in the mainnet-shaped local rehearsal.
const MAINNET_SHAPE = NET === 'mainnet' || (NET === 'sandbox' && process.env.REHEARSE === 'mainnet');

const NEAR = 10n ** 24n;
let MPC_ACCOUNT = 'v1.signer-prod.testnet';
const near = (n: number) => (BigInt(Math.round(n * 1000)) * NEAR) / 1000n;

const RULES = [
  { id: 'age_over_18', claim: 'is at least 18 years old', enabled: true },
  { id: 'income_at_least_50k', claim: 'has a yearly income of at least 50,000 USD', enabled: true },
  { id: 'github_contributor_5', claim: 'has at least 5 merged pull requests on public GitHub repositories', enabled: true },
  { id: 'employed', claim: 'is currently employed', enabled: true },
];

// #mainnet: the faucet token is testnet only; mainnet stakes a real NEP-141 named by STAKING_TOKEN.
function stakingToken(c: ReturnType<typeof contractIdsFor>): string {
  if (!MAINNET_SHAPE) return c.token;
  if (!process.env.STAKING_TOKEN) throw new Error('#mainnet: set STAKING_TOKEN to the NEP-141 that authorities stake');
  return process.env.STAKING_TOKEN;
}

type Plan = { name: string; crate: string; balance: number; init: (ids: ReturnType<typeof contractIdsFor>, root: string) => object; probe: string };

const PLAN: Plan[] = [
  { name: 'schemas', crate: 'schemas', balance: 4, init: (c, r) => ({ owner: r, attestations: c.attestations }), probe: 'get_config' },
  { name: 'attestations', crate: 'attestations', balance: 6, init: (c, r) => ({ owner: r, governance: process.env.GOVERNANCE ?? r, schemas: c.schemas }), probe: 'get_config' },
  { name: 'token', crate: 'token', balance: 3, init: (_c, r) => ({ owner: r, total_supply: (1_000_000n * 10n ** 18n).toString() }), probe: 'ft_metadata' },
  { name: 'staking', crate: 'staking', balance: 2.5, init: (c, r) => ({ owner: r, token: stakingToken(c), attestations: c.attestations, tiers: [] }), probe: 'get_tiers' },
  { name: 'credentials', crate: 'credentials', balance: 3, init: (c, r) => ({ owner: r, attestations: c.attestations }), probe: 'nft_metadata' },
  { name: 'verdicts', crate: 'verdicts', balance: 4, init: (c, r) => ({ owner: r, attestations: c.attestations, mpc: MPC_ACCOUNT }), probe: 'get_config' },
  ...(['whitelist', 'fee', 'gated', 'reward', 'pipeline'] as const).map((n) => ({
    name: n,
    crate: 'resolvers',
    balance: 4,
    init: (c: ReturnType<typeof contractIdsFor>, r: string) => ({
      owner: r,
      kind: { whitelist: 'whitelist', fee: 'fee', gated: 'token_gated', reward: 'token_reward', pipeline: 'pipeline' }[n],
      schemas: c.schemas,
      attestations: c.attestations,
    }),
    probe: 'resolver_info',
  })),
];

function wasmPath(crate: string): string {
  const build = process.env.BUILD;
  if (build) {
    const commit = execFileSync('git', ['rev-parse', `${build}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim();
    return join(repo, 'contracts/target/near-reproducible', commit, `attestra_${crate}.wasm`);
  }
  if (MAINNET_SHAPE) throw new Error('mainnet deploys only reproducible builds: set BUILD=<commit>');
  return join(repo, 'contracts/target/near', `attestra_${crate}`, `attestra_${crate}.wasm`);
}

const codeHash = (bytes: Uint8Array) => base58Encode(createHash('sha256').update(bytes).digest());

async function main() {
  let sandbox: Sandbox | undefined;
  let nearClient: Near;
  let root: string;
  let rpcUrl: string;
  let keyStore: FileKeyStore | InMemoryKeyStore;
  let mpc = '';
  // #mainnet: native USDC on mainnet, a stand-in NEP-141 in the rehearsal, the faucet token otherwise.
  let paymentToken: string | undefined;
  let rootSecret: string | undefined;

  if (NET === 'sandbox') {
    sandbox = await Sandbox.start({ detached: false });
    rpcUrl = sandbox.rpcUrl;
    keyStore = new InMemoryKeyStore({ [sandbox.rootAccount.id]: sandbox.rootAccount.secretKey });
    const base = new Near({ network: { rpcUrl, networkId: sandbox.networkId }, keyStore });
    root = `attestra.${sandbox.rootAccount.id}`;
    const rk = generateKey();
    await keyStore.add(root, rk);
    rootSecret = rk.secretKey;
    await base.transaction(sandbox.rootAccount.id).createAccount(root).transfer(root, '200 NEAR').addKey(rk.publicKey.toString(), { type: 'fullAccess' }).send();
    nearClient = new Near({ network: { rpcUrl, networkId: sandbox.networkId }, keyStore });
    if (MAINNET_SHAPE) {
      const standIn = `usdc.${sandbox.rootAccount.id}`;
      const sk = generateKey();
      await keyStore.add(standIn, sk);
      await base
        .transaction(sandbox.rootAccount.id)
        .createAccount(standIn)
        .transfer(standIn, '5 NEAR')
        .addKey(sk.publicKey.toString(), { type: 'fullAccess' })
        .deployContract(standIn, new Uint8Array(readFileSync(wasmPath('token'))))
        .functionCall(standIn, 'new', { owner: root, total_supply: (1_000_000n * 10n ** 6n).toString() }, { gas: '100 Tgas' })
        .send();
      paymentToken = standIn;
      process.env.STAKING_TOKEN ??= standIn;
      log(`rehearsing mainnet: ${standIn} stands in for USDC and the staking token`);
    }
  } else {
    if (NET === 'mainnet' && process.env.ATTESTRA_MAINNET_GO !== ((process.env.ATTESTRA_ROOT ?? process.env.ROOT) ?? DEFAULT_ROOTS.mainnet)) {
      throw new Error('#mainnet: refusing without ATTESTRA_MAINNET_GO set to the root account (the owner must approve)');
    }
    const net = resolveNetwork(NET, { root: (process.env.ATTESTRA_ROOT ?? process.env.ROOT) });
    root = net.root;
    rpcUrl = process.env.RPC_URL ?? net.rpcUrls[0];
    mpc = net.mpc;
    MPC_ACCOUNT = net.mpc;
    if (NET === 'mainnet') paymentToken = net.paymentToken;
    keyStore = new FileKeyStore(join(homedir(), '.near-credentials'), NET);
    nearClient = new Near({ network: NET, rpcUrl, keyStore });
  }

  const ids = contractIdsFor(root);
  const accountOf = (name: string) => `${name}.${root}`;
  // Retries a throttled or failed answer (the free RPC tier allows about 60 requests a minute), so
  // a transient failure never reads as "this account or contract does not exist".
  const rpc = async <T>(method: string, params: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      let transient: string;
      try {
        const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (res.ok) {
          const j = (await res.json()) as { result?: T; error?: { cause?: { name?: string } } };
          if (j.error && !/TOO_MANY_REQUESTS|TIMEOUT_ERROR|INTERNAL_ERROR/.test(j.error.cause?.name ?? '')) throw Object.assign(new Error(JSON.stringify(j.error)), { rpcError: j.error });
          if (!j.error && j.result !== undefined) return j.result;
          transient = JSON.stringify(j.error ?? 'empty answer');
        } else transient = `HTTP ${res.status}`;
      } catch (e) {
        if ((e as { rpcError?: unknown }).rpcError) throw e;
        transient = (e as Error).message;
      }
      if (attempt >= 5) throw new Error(`RPC ${method} kept failing: ${transient}`);
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  };
  const account = (id: string) =>
    rpc<{ code_hash: string; amount: string }>('query', { request_type: 'view_account', finality: 'optimistic', account_id: id }).catch((e) => {
      if (/UNKNOWN_ACCOUNT/.test((e as Error).message)) return null;
      throw e;
    });
  const view = async <T>(id: string, method: string, args: object = {}): Promise<T | null> => {
    try {
      const r = await rpc<{ result: number[] }>('query', {
        request_type: 'call_function',
        finality: 'optimistic',
        account_id: id,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      });
      return JSON.parse(Buffer.from(r.result).toString('utf8')) as T;
    } catch {
      return null;
    }
  };
  // Says "not initialized" only when the contract says so; any other failure is retried, then fatal,
  // so a slow RPC never makes the script re-initialize a live contract.
  const isInitialized = async (id: string, method: string): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await rpc<{ result?: number[]; error?: string }>('query', { request_type: 'call_function', finality: 'optimistic', account_id: id, method_name: method, args_base64: Buffer.from('{}').toString('base64') });
        if (r.result) return true;
        if (/not initialized|CodeDoesNotExist|MethodNotFound|Cannot deserialize the contract state/i.test(r.error ?? '')) return false;
        throw new Error(r.error ?? `${id}.${method} returned nothing`);
      } catch (e) {
        if (/not initialized|CodeDoesNotExist|MethodNotFound|Cannot deserialize the contract state/i.test((e as Error).message)) return false;
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  };
  const call = async (signer: string, contract: string, method: string, args: object, deposit = '0', gas: `${number} Tgas` = '100 Tgas') => {
    const out = await nearClient.transaction(signer).functionCall(contract, method, args, { gas, attachedDeposit: `${deposit} yocto` as never }).send();
    return (out as { transaction: { hash: string } }).transaction.hash;
  };

  const record: Record<string, unknown> = {
    network: NET,
    root,
    // The commit the code was built from: BUILD for a reproducible build, else the checkout.
    commit: execFileSync('git', ['rev-parse', `${process.env.BUILD ?? 'HEAD'}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim(),
    build: process.env.BUILD ? 'reproducible' : 'local',
    deployed_at: new Date().toISOString(),
    contracts: {} as Record<string, unknown>,
    schemas: {} as Record<string, unknown>,
    external: { mpc },
  };
  const contracts = record.contracts as Record<string, Record<string, unknown>>;
  // The indexer starts here on an empty database: the first deploy's block, kept across reruns.
  const previousFile = join(repo, `deployments/${NET}.json`);
  const previousStart = existsSync(previousFile) ? (JSON.parse(readFileSync(previousFile, 'utf8')).start_height as number | undefined) : undefined;
  // The OutLayer checker (scripts/outlayer-publish.ts) and the DAO (scripts/dao.ts) are recorded by their own
  // scripts; a redeploy keeps their records.
  const previous = existsSync(previousFile) ? (JSON.parse(readFileSync(previousFile, 'utf8')) as { checker?: unknown; dao?: unknown }) : {};
  if (previous.checker) record.checker = previous.checker;
  if (previous.dao) record.dao = previous.dao;
  record.start_height = previousStart ?? (await rpc<{ header: { height: number } }>('block', { finality: 'final' })).header.height - 10;

  // 1. accounts and code
  for (const p of PLAN.filter((p) => !MAINNET_SHAPE || p.name !== 'token')) {
    const id = accountOf(p.name);
    const wasm = readFileSync(wasmPath(p.crate));
    const hash = codeHash(wasm);
    const acct = await account(id);
    let tx: string | undefined;
    if (!acct) {
      const key = generateKey();
      await keyStore.add(id, key);
      const storage = Number(BigInt(wasm.length) * 10n ** 19n / 10n ** 21n) / 1000;
      const balance = Math.max(p.balance, Math.ceil((storage + 1) * 10) / 10);
      const out = await nearClient
        .transaction(root)
        .createAccount(id)
        .transfer(id, `${near(balance)} yocto`)
        .addKey(key.publicKey.toString(), { type: 'fullAccess' })
        .send();
      log(`created ${id} with ${balance} NEAR (${(out as { transaction: { hash: string } }).transaction.hash})`);
    }
    const now = await account(id);
    const initialized = await isInitialized(id, p.probe);
    if (!now || now.code_hash === '11111111111111111111111111111111' || !initialized) {
      const out = await nearClient
        .transaction(id)
        .deployContract(id, new Uint8Array(wasm))
        .functionCall(id, 'new', p.init(ids, root), { gas: '100 Tgas' })
        .send();
      tx = (out as { transaction: { hash: string } }).transaction.hash;
      log(`deployed ${id} ${hash} (${tx})`);
    } else if (now.code_hash !== hash && process.env.UPGRADE) {
      const out = await nearClient.transaction(id).deployContract(id, new Uint8Array(wasm)).send();
      tx = (out as { transaction: { hash: string } }).transaction.hash;
      log(`upgraded ${id} to ${hash} (${tx})`);
    } else if (now.code_hash !== hash) {
      log(`warning: ${id} runs ${now.code_hash}, local build is ${hash} (set UPGRADE=1 to redeploy)`);
    }
    // An RPC node can still answer with the code from before a deploy for a moment: wait until it shows the new code.
    let final = await account(id);
    for (let i = 0; tx && final?.code_hash !== hash && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      final = await account(id);
    }
    if (tx && final?.code_hash !== hash) throw new Error(`${id} does not show ${hash} after the deploy (${tx})`);
    const previous = existsSync(join(repo, `deployments/${NET}.json`))
      ? (JSON.parse(readFileSync(join(repo, `deployments/${NET}.json`), 'utf8')).contracts?.[p.name] ?? {})
      : {};
    contracts[p.name] = { account: id, crate: `attestra-${p.crate}`, code_hash: final?.code_hash, deploy_tx: tx ?? previous.deploy_tx ?? null, wasm_bytes: wasm.length };
  }

  // 2. wiring
  const cfg = await view<{ credentials: string | null; staking: string | null }>(ids.attestations, 'get_config');
  if (cfg?.credentials !== ids.credentials) log(`set_credentials ${await call(root, ids.attestations, 'set_credentials', { credentials: ids.credentials }, '1')}`);
  if (cfg?.staking !== ids.staking) log(`set_staking ${await call(root, ids.attestations, 'set_staking', { staking: ids.staking }, '1')}`);
  for (const r of [ids.resolvers.whitelist, ids.resolvers.fee, ids.resolvers.tokenGated, ids.resolvers.tokenReward]) {
    const info = await view<{ trusted_pipelines: string[] }>(r, 'resolver_info');
    if (!info?.trusted_pipelines.includes(ids.resolvers.pipeline)) log(`trust pipeline on ${r} ${await call(root, r, 'add_trusted_pipeline', { account_id: ids.resolvers.pipeline })}`);
  }
  // The fee resolver accepts prepaid balances only in tokens its owner lists.
  const feeTokens = (await view<string[]>(ids.resolvers.fee, 'fee_tokens')) ?? [];
  const feeToken = paymentToken ?? ids.token;
  if (!feeTokens.includes(feeToken)) log(`fee token ${feeToken} ${await call(root, ids.resolvers.fee, 'add_fee_token', { token: feeToken }, '1')}`);
  // Token storage for contracts that receive or hold the payment token, and for staking in its token.
  const holders: [string, string][] = [ids.resolvers.fee, ids.resolvers.tokenReward, ids.resolvers.tokenGated, `agent.${root}`].map((h) => [feeToken, h]);
  holders.push([stakingToken(ids), ids.staking]);
  for (const [token, holder] of holders) {
    if (!(await view(token, 'storage_balance_of', { account_id: holder }))) {
      log(`${token} storage for ${holder} ${await call(root, token, 'storage_deposit', { account_id: holder, registration_only: true }, (125n * 10n ** 19n).toString())}`);
    }
  }
  // The verdicts contract attests from its own storage balance.
  const vb = await view<{ available: string }>(ids.attestations, 'storage_balance_of', { account_id: ids.verdicts });
  if (!vb || BigInt(vb.available) < near(0.5)) log(`verdicts storage ${await call(root, ids.attestations, 'storage_deposit', { account_id: ids.verdicts }, near(1).toString())}`);

  // 3. well-known schemas, registered by the root
  const sb = await view<{ available: string }>(ids.schemas, 'storage_balance_of', { account_id: root });
  if (!sb || BigInt(sb.available) < near(0.2)) log(`schemas storage ${await call(root, ids.schemas, 'storage_deposit', {}, near(0.5).toString())}`);
  const schemas = record.schemas as Record<string, unknown>;
  for (const [key, s] of Object.entries(KNOWN_SCHEMAS)) {
    const uid = knownSchemaUid(key as keyof typeof KNOWN_SCHEMAS);
    if (!(await view(ids.schemas, 'get_schema', { uid }))) {
      log(`schema ${key} ${await call(root, ids.schemas, 'register_schema', { definition: s.definition, resolver: null, revocable: s.revocable }, '0', '150 Tgas')}`);
    }
    schemas[key] = uid;
  }

  // 4. verdicts configuration
  const vc = await view<Record<string, any>>(ids.verdicts, 'get_config');
  if (vc && vc.schemas?.ai_check !== knownSchemaUid('aiCheck')) {
    log(`verdicts schemas ${await call(root, ids.verdicts, 'set_schemas', { ai_check: knownSchemaUid('aiCheck'), foreign_tx: knownSchemaUid('foreignEvent'), wallet_link: knownSchemaUid('walletLink') }, '1')}`);
  }
  // Solana facts are attested under their own schema, kept apart from the stored config.
  if (vc && vc.instruction_schema !== knownSchemaUid('foreignInstruction')) {
    log(`verdicts instruction schema ${await call(root, ids.verdicts, 'set_instruction_schema', { uid: knownSchemaUid('foreignInstruction') }, '1')}`);
  }
  if (vc && JSON.stringify((vc.rules ?? []).map((r: { id: string }) => r.id)) !== JSON.stringify(RULES.map((r) => r.id))) {
    log(`verdicts rules ${await call(root, ids.verdicts, 'set_rules', { rules: RULES }, '1')}`);
  }
  if (mpc) {
    const key = await view<string>(mpc, 'public_key', { domain_id: 3 });
    const keyStr = typeof key === 'string' ? key : (key as { Secp256k1?: { near_public_key?: string } } | null)?.Secp256k1?.near_public_key;
    if (keyStr && vc?.mpc_key !== keyStr) log(`verdicts mpc key ${await call(root, ids.verdicts, 'set_mpc_key', { public_key: keyStr, domain_id: 3 }, '1')}`);
    if (vc?.mpc !== mpc) log(`note: verdicts was initialized with mpc ${vc?.mpc}; expected ${mpc}`);
  }
  if (process.env.ENCLAVE_PUBLIC_KEY && !(vc?.enclave_keys ?? []).includes(process.env.ENCLAVE_PUBLIC_KEY)) {
    log(`verdicts enclave key ${await call(root, ids.verdicts, 'set_enclave_keys', { keys: [process.env.ENCLAVE_PUBLIC_KEY] }, '1')}`);
  }
  if (process.env.MODEL_SIGNERS) {
    log(`verdicts model signers ${await call(root, ids.verdicts, 'set_model_signers', { signers: JSON.parse(process.env.MODEL_SIGNERS) }, '1')}`);
  }

  // 5. record
  const out = NET === 'sandbox' ? join(repo, `.data/deployments/${MAINNET_SHAPE ? 'sandbox-mainnet' : 'sandbox'}.json`) : join(repo, `deployments/${NET}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  log(`wrote ${out}`);
  if (sandbox && process.env.HOLD) {
    writeFileSync(process.env.HOLD, JSON.stringify({ rpcUrl, root, rootSecret, paymentToken: paymentToken ?? ids.token }));
    log(`holding the sandbox at ${rpcUrl} (details in ${process.env.HOLD})`);
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
  }
  if (sandbox) await sandbox.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { parseKey };

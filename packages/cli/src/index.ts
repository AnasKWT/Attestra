/**
 * attestra: the Attestra command line.
 *
 *   attestra schema create --definition "string name, u8 level" --revocable --account alice.testnet
 *   attestra attestation create --schema <uid> --subject bob.testnet --values '{"name":"Bob","level":3}'
 *   attestra events prove <attestation uid>
 *
 * Every command takes --json. Signing commands need --account (or ATTESTRA_ACCOUNT_ID) with a key
 * in the NEAR CLI keychain or ATTESTRA_PRIVATE_KEY.
 */

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  AGENT_KEY_ALLOWANCE_NEAR,
  AGENT_KEY_GRANTABLE_METHODS,
  AGENT_KEY_METHODS,
  AttestraClient,
  KNOWN_SCHEMAS,
  NEAR_AI_BASE_URL,
  SchemaEncoder,
  computeSchemaUid,
  keySigner,
  knownSchemas,
  fetchWithRetry,
  openAITools,
  pickVerifiableModel,
  runTool,
  type MultisigAction,
  type ServiceResponse,
} from '@attestra/sdk';
import { resolveConfig, type CliOptions } from './config';
import { bold, dim, formatError, formatOutput, orange, print } from './output';

const program = new Command();
program
  .name('attestra')
  .description('Attestra: the trust layer for NEAR. Schemas, attestations, authorities and verifiable facts.')
  .version('1.0.0')
  .option('--json', 'output JSON')
  .option('-n, --network <network>', 'testnet or mainnet (env ATTESTRA_NETWORK)')
  .option('-a, --account <account>', 'signer account (env ATTESTRA_ACCOUNT_ID); key from the NEAR keychain or ATTESTRA_PRIVATE_KEY')
  .option('--root <root>', 'deployment root account (env ATTESTRA_ROOT)')
  .option('--rpc <url>', 'RPC URL (env ATTESTRA_RPC_URL)')
  .option('--indexer <url>', 'indexer URL (env ATTESTRA_INDEXER_URL)')
  .option('--relayer <url>', 'relayer URL (env ATTESTRA_RELAYER_URL)')
  .option('--agent <url>', 'Attestra agent URL (env ATTESTRA_AGENT_URL)');

const json = () => Boolean(program.opts().json);
let cached: AttestraClient | undefined;
function client(): AttestraClient {
  cached ??= new AttestraClient(resolveConfig(program.opts() as CliOptions));
  return cached;
}
const explorer = () => client().config.explorerUrl;
const out = async <T>(p: Promise<ServiceResponse<T>>) => print(await p, json(), explorer());
const fail = (type: string, message: string) => {
  console.error(formatError(type, message, json()));
  process.exitCode = 1;
};

function parseJson<T>(text: string | undefined, what: string): T | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text.startsWith('@') ? readFileSync(text.slice(1), 'utf8') : text) as T;
  } catch {
    throw new Error(`${what} must be JSON (or @file.json)`);
  }
}

/** Encodes `--values` with the schema's definition unless raw `--data` (base64) is given. */
async function encodeData(schemaUid: string, values?: string, data?: string): Promise<string> {
  if (data) return data;
  const v = parseJson<Record<string, unknown>>(values, '--values') ?? {};
  const s = await client().getSchema(schemaUid);
  if (!s.success || !s.data) throw new Error(s.error?.message ?? 'schema not found');
  return new SchemaEncoder(s.data.definition).encode(v);
}

function wrap<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      fail('VALIDATION_ERROR', (e as Error).message);
    }
  };
}

const num = (v: string) => Number(v);

// ─── schema ─────────────────────────────────────────────────────────────────
const schema = program.command('schema').description('register and read schemas');
schema
  .command('create')
  .description('register a schema')
  .requiredOption('-d, --definition <definition>', 'fields, e.g. "string name, u8 level, bool verified"')
  .option('--revocable', 'attestations can be revoked', false)
  .option('-r, --resolver <account>', 'resolver account')
  .action(wrap(async (o) => out(client().registerSchema({ definition: o.definition, revocable: o.revocable, resolver: o.resolver }))));
schema.command('fetch <uid>').description('read a schema').action(wrap(async (uid) => out(client().getSchema(uid))));
schema
  .command('list')
  .option('--authority <account>', 'only this authority')
  .option('--limit <n>', 'max results', '25')
  .action(wrap(async (o) => out(client().listSchemas({ authority: o.authority, limit: num(o.limit) }))));
schema
  .command('uid')
  .description('compute a schema UID without registering')
  .requiredOption('-d, --definition <definition>')
  .option('--revocable', 'revocable', false)
  .option('-r, --resolver <account>')
  .action(wrap(async (o) => out(Promise.resolve({ success: true, data: { uid: computeSchemaUid(o.definition, o.resolver ?? null, o.revocable) } }))));
schema.command('known').description('well-known schemas and their UIDs').action(wrap(async () => out(Promise.resolve({ success: true, data: knownSchemas() }))));

// ─── blob (large schemas) ───────────────────────────────────────────────────
const blob = program.command('blob').alias('large-schema').description('large schema definitions stored on chain (NEP-145)');
blob
  .command('store')
  .requiredOption('-f, --file <path>', 'text file with the definition')
  .action(wrap(async (o) => out(client().storeSchemaBlob(readFileSync(o.file, 'utf8').trim()))));
blob.command('fetch <hash>').action(wrap(async (hash) => out(client().getSchemaBlob(hash))));
blob
  .command('register <hash>')
  .option('--revocable', 'revocable', false)
  .option('-r, --resolver <account>')
  .action(wrap(async (hash, o) => out(client().registerSchemaFromBlob({ blobHash: hash, revocable: o.revocable, resolver: o.resolver }))));

// ─── attestation ────────────────────────────────────────────────────────────
const attestation = program.command('attestation').description('issue, read and revoke attestations');
attestation
  .command('create')
  .requiredOption('-s, --schema <uid>', 'schema UID')
  .requiredOption('--subject <subject>', 'NEAR account or CAIP-10 id (eip155:1:0x...)')
  .option('-v, --values <json>', 'field values as JSON (or @file.json)')
  .option('--data <base64>', 'raw Borsh data instead of --values')
  .option('-e, --expiration <unix>', 'expiration time (unix seconds)')
  .option('--ref <uid>', 'referenced attestation UID')
  .action(
    wrap(async (o) => {
      const data = await encodeData(o.schema, o.values, o.data);
      await out(client().createAttestation({ schemaUid: o.schema, subject: o.subject, data, expirationTime: o.expiration ? num(o.expiration) : undefined, refUid: o.ref }));
    }),
  );
attestation
  .command('fetch <uid>')
  .option('--decode', 'decode the data with its schema', true)
  .action(
    wrap(async (uid) => {
      const r = await client().getAttestation(uid);
      if (r.success && r.data) {
        const s = await client().getSchema(r.data.schema_uid);
        let decoded: unknown = null;
        try {
          decoded = s.data ? new SchemaEncoder(s.data.definition).decode(r.data.data) : null;
        } catch {
          decoded = null;
        }
        print({ success: true, data: { ...r.data, decoded } }, json(), explorer());
      } else print(r, json());
    }),
  );
attestation.command('verify <uid>').description('is it valid right now?').action(wrap(async (uid) => out(client().isValid(uid))));
attestation
  .command('list')
  .option('--attester <account>')
  .option('--subject <subject>')
  .option('--schema <uid>')
  .option('--status <status>')
  .option('--limit <n>', 'max results', '25')
  .action(wrap(async (o) => out(client().listAttestations({ attester: o.attester, subject: o.subject, schemaUid: o.schema, status: o.status, limit: num(o.limit) }))));
attestation.command('revoke <uid>').action(wrap(async (uid) => out(client().revokeAttestation(uid))));

// ─── authority ──────────────────────────────────────────────────────────────
const authority = program.command('authority').description('authorities (issuers)');
authority
  .command('register')
  .requiredOption('-m, --metadata <text>', 'who you are')
  .option('-k, --kind <kind>', 'organization, person, agent, verifier or other')
  .action(wrap(async (o) => out(client().registerAuthority(o.metadata, o.kind))));
authority.command('fetch <account>').action(wrap(async (a) => out(client().getAuthority(a))));
authority
  .command('verify <account>')
  .description('governance only')
  .option('--revoke', 'remove verification', false)
  .action(wrap(async (a, o) => out(client().setAuthorityVerification(a, !o.revoke))));
program.command('profile <account>').description('schemas, issued and received attestations of an account').action(wrap(async (a) => out(client().getProfile(a))));

// ─── storage ────────────────────────────────────────────────────────────────
const storage = program.command('storage').description('NEP-145 storage balances');
storage
  .command('deposit <contract> <yocto>')
  .description('contract is schemas or attestations')
  .option('--for <account>', 'deposit for another account')
  .action(wrap(async (c, amount, o) => out(client().storageDeposit(c, amount, o.for))));
storage.command('balance <contract> <account>').action(wrap(async (c, a) => out(client().storageBalance(c, a))));
storage.command('withdraw <contract> [yocto]').action(wrap(async (c, amount) => out(client().storageWithdraw(c, amount))));

// ─── delegate ───────────────────────────────────────────────────────────────
const delegate = program.command('delegate').description('delegation: on-chain grants and NEP-413 signed requests');
delegate
  .command('add <delegate>')
  .option('--schemas <uids>', 'comma-separated schema UIDs (default: any)')
  .option('--expires <unix>', 'expiry')
  .option('--max-uses <n>', 'max attestations')
  .option('--can-revoke', 'may revoke too', false)
  .option('--label <label>')
  .action(
    wrap(async (d, o) =>
      out(client().addDelegate(d, { schemas: o.schemas?.split(','), expiresAt: o.expires ? num(o.expires) : undefined, maxUses: o.maxUses ? num(o.maxUses) : undefined, canRevoke: o.canRevoke, label: o.label })),
    ),
  );
delegate.command('remove <delegate>').action(wrap(async (d) => out(client().removeDelegate(d))));
delegate.command('list <authority>').action(wrap(async (a) => out(client().getDelegates(a))));
delegate.command('check <authority> <delegate>').action(wrap(async (a, d) => out(client().isDelegate(a, d))));
delegate
  .command('attest')
  .description('attest for an authority as its delegate')
  .requiredOption('--authority <account>')
  .requiredOption('-s, --schema <uid>')
  .requiredOption('--subject <subject>')
  .option('-v, --values <json>')
  .option('--data <base64>')
  .action(wrap(async (o) => out(client().attestOnBehalf({ authority: o.authority, schemaUid: o.schema, subject: o.subject, data: await encodeData(o.schema, o.values, o.data) }))));
delegate.command('revoke <uid>').description('revoke for an authority as its delegate').action(wrap(async (uid) => out(client().revokeOnBehalf(uid))));
delegate.command('add-key <publicKey>').description('register a key that may sign requests for you').action(wrap(async (k) => out(client().addSignerKey(k))));
delegate.command('keys <account>').action(wrap(async (a) => out(client().getSignerKeys(a))));
delegate
  .command('sign')
  .description('sign a delegated attestation off chain (key from ATTESTRA_SIGNER_KEY); prints the request')
  .requiredOption('--attester <account>')
  .requiredOption('-s, --schema <uid>')
  .requiredOption('--subject <subject>')
  .option('-v, --values <json>')
  .option('--data <base64>')
  .option('--deadline <unix>')
  .action(
    wrap(async (o) => {
      const key = process.env.ATTESTRA_SIGNER_KEY;
      if (!key) throw new Error('set ATTESTRA_SIGNER_KEY to the ed25519 secret key that signs');
      const data = await encodeData(o.schema, o.values, o.data);
      await out(client().signDelegatedAttestation({ attester: o.attester, schemaUid: o.schema, subject: o.subject, data, deadline: o.deadline ? num(o.deadline) : undefined }, keySigner(key)));
    }),
  );
delegate
  .command('submit <request>')
  .description('submit a signed request (JSON or @file); --relay sends it to the relayer, which pays the gas')
  .option('--relay', 'use the relayer', false)
  .action(
    wrap(async (req, o) => {
      const r = parseJson<Parameters<AttestraClient['submitSigned']>[0]>(req, 'request')!;
      await out(o.relay ? client().relaySigned(r) : client().submitSigned(r));
    }),
  );

// ─── resolvers ──────────────────────────────────────────────────────────────
const whitelist = program.command('whitelist').description('whitelist resolver (per schema)');
whitelist.command('add <schema> <account>').action(wrap(async (s, a) => out(client().whitelistAdd(s, a))));
whitelist.command('remove <schema> <account>').action(wrap(async (s, a) => out(client().whitelistRemove(s, a))));
whitelist.command('check <schema> <account>').action(wrap(async (s, a) => out(client().whitelistCheck(s, a))));
whitelist.command('info').action(wrap(async () => out(client().resolverInfo(client().contracts.resolvers.whitelist))));

const fee = program.command('fee').description('fee resolver (NEAR or NEP-141, prepaid)');
fee.command('set-fee <schema> <amount>').option('--token <account>', 'NEP-141 (default NEAR)').action(wrap(async (s, a, o) => out(client().feeSetFee(s, a, o.token))));
fee.command('get-fee <schema>').action(wrap(async (s) => out(client().feeGetFee(s))));
fee.command('deposit <amount>').option('--token <account>').action(wrap(async (a, o) => out(client().feeDeposit(a, o.token))));
fee.command('balance <account>').option('--token <account>').action(wrap(async (a, o) => out(client().feeGetBalance(a, o.token))));
fee.command('collected <schema>').option('--token <account>').action(wrap(async (s, o) => out(client().feeCollected(s, o.token))));
fee.command('withdraw <schema>').description('schema admin takes collected fees').option('--token <account>').action(wrap(async (s, o) => out(client().feeWithdraw(s, o.token))));
fee.command('refund').description('take back unused prepaid balance').option('--token <account>').option('--amount <amount>').action(wrap(async (o) => out(client().feeWithdrawBalance(o.token, o.amount))));

const gated = program.command('token-gated').description('token-gated resolver (NEP-141 balance)');
gated.command('set-config <schema> <token> <minBalance>').action(wrap(async (s, t, m) => out(client().tokenGatedSetConfig(s, t, m))));
gated.command('get-config <schema>').action(wrap(async (s) => out(client().tokenGatedGetConfig(s))));

const reward = program.command('token-reward').description('token reward resolver (pays NEP-141 to subjects)');
reward.command('set-config <schema> <token> <amount>').action(wrap(async (s, t, a) => out(client().tokenRewardSetConfig(s, t, a))));
reward.command('fund <schema> <token> <amount>').action(wrap(async (s, t, a) => out(client().tokenRewardFund(s, t, a))));
reward.command('get-config <schema>').action(wrap(async (s) => out(client().tokenRewardGetConfig(s))));
reward.command('distributed <schema> <account>').action(wrap(async (s, a) => out(client().tokenRewardGetDistributed(s, a))));

const pipeline = program.command('pipeline').alias('cross-contract').description('pipeline resolver (chained cross-contract resolvers)');
pipeline.command('set <schema> <resolvers>').description('resolvers comma-separated, in order').action(wrap(async (s, r) => out(client().pipelineSetResolvers(s, r.split(',')))));
pipeline.command('get <schema>').action(wrap(async (s) => out(client().pipelineGetResolvers(s))));

// ─── credential ─────────────────────────────────────────────────────────────
const credential = program.command('credential').description('NEP-171 non-transferable credentials');
credential.command('mint <attestationUid>').action(wrap(async (u) => out(client().mintCredential(u))));
credential.command('fetch <attestationUid>').action(wrap(async (u) => out(client().getCredential(u))));
credential.command('list <owner>').action(wrap(async (o) => out(client().listCredentials(o))));

// ─── schedule ───────────────────────────────────────────────────────────────
const schedule = program.command('schedule').description('scheduled revocations');
schedule
  .command('revoke <uid>')
  .option('--at <unix>', 'revoke at (unix seconds)')
  .option('--in <seconds>', 'revoke in N seconds')
  .action(
    wrap(async (uid, o) => {
      const at = o.at ? num(o.at) : Math.floor(Date.now() / 1000) + num(o.in ?? '3600');
      await out(client().scheduleRevocation(uid, at));
    }),
  );
schedule.command('status <uid>').action(wrap(async (uid) => out(client().getScheduledRevocation(uid))));
schedule.command('finalize <uid>').action(wrap(async (uid) => out(client().finalizeRevocation(uid))));

// ─── multisig ───────────────────────────────────────────────────────────────
const multisig = program.command('multisig').description('k-of-n multisig authorities');
multisig
  .command('create')
  .requiredOption('--members <accounts>', 'comma-separated')
  .requiredOption('--threshold <k>')
  .requiredOption('-m, --metadata <text>')
  .action(wrap(async (o) => out(client().createMultisigAuthority({ members: o.members.split(','), threshold: num(o.threshold), metadata: o.metadata }))));
multisig
  .command('propose-attest <multisig>')
  .requiredOption('-s, --schema <uid>')
  .requiredOption('--subject <subject>')
  .option('-v, --values <json>')
  .option('--data <base64>')
  .action(
    wrap(async (ms, o) => {
      const action: MultisigAction = { type: 'attest', schema_uid: o.schema, subject: o.subject, data: await encodeData(o.schema, o.values, o.data) };
      await out(client().proposeMultisig(ms, action));
    }),
  );
multisig.command('propose-revoke <multisig> <uid>').action(wrap(async (ms, uid) => out(client().proposeMultisig(ms, { type: 'revoke', uid }))));
multisig.command('approve <proposalId>').action(wrap(async (id) => out(client().approveMultisig(num(id)))));
multisig.command('execute <proposalId>').action(wrap(async (id) => out(client().executeMultisig(num(id)))));
multisig.command('cancel <proposalId>').action(wrap(async (id) => out(client().cancelMultisig(num(id)))));
multisig.command('fetch <multisig>').action(wrap(async (id) => out(client().getMultisig(id))));
multisig.command('proposal <proposalId>').action(wrap(async (id) => out(client().getProposal(num(id)))));

// ─── staking and the test token ─────────────────────────────────────────────
const staking = program.command('staking').description('authority staking tiers (NEP-141)');
staking.command('stake <amount>').description('amount in the smallest unit').action(wrap(async (a) => out(client().stake(a))));
staking.command('unstake <amount>').action(wrap(async (a) => out(client().unstake(a))));
staking.command('info <account>').action(wrap(async (a) => out(client().getStake(a))));
staking.command('tiers').action(wrap(async () => out(client().getTiers())));
const token = program.command('token').description('the testnet test token');
token.command('faucet').description('1,000 test tokens, once an hour').action(wrap(async () => out(client().faucet())));
token.command('balance <account>').action(wrap(async (a) => out(client().tokenBalance(a))));

// ─── events (audit trail) ───────────────────────────────────────────────────
const events = program.command('events').description('NEP-297 audit trail and light client proofs');
events
  .command('list')
  .option('--event <name>')
  .option('--account <account>')
  .option('--uid <uid>')
  .option('--limit <n>', 'max results', '25')
  .action(wrap(async (o) => out(client().listEvents({ event: o.event, account: o.account, uid: o.uid, limit: num(o.limit) }))));
events
  .command('prove <uid>')
  .description('prove the event behind an attestation is final, checked locally')
  .option('--revoked', 'prove the revocation event instead', false)
  .action(wrap(async (uid, o) => out(client().proveAttestation(uid, o.revoked ? 'attestation_revoked' : 'attestation_created'))));
events
  .command('prove-receipt <receiptId> <receiver>')
  .action(wrap(async (r, recv) => out(client().proveReceipt(r, recv))));

// ─── only on NEAR ───────────────────────────────────────────────────────────
const check = program.command('check').description('private facts checked by verifiable AI (NEAR AI Cloud + enclave)');
check
  .command('run <ruleId>')
  .requiredOption('--subject <subject>')
  .option('--evidence <text>', 'private evidence (or @file)')
  .option('--github <login>', 'GitHub login for github_contributor')
  .action(
    wrap(async (rule, o) => {
      const evidence = o.evidence?.startsWith('@') ? readFileSync(o.evidence.slice(1), 'utf8') : (o.evidence ?? '');
      await out(client().requestPrivateCheck({ ruleId: rule, subject: o.subject, evidence, github: o.github }));
    }),
  );
check.command('rules').action(wrap(async () => out(client().verdictsConfig())));

const chain = program.command('chain').description('facts about other chains, without an oracle');
chain
  .command('link-message <chain> <address>')
  .description('chain is eip155 or solana; prints the text the wallet signs')
  .action(wrap(async (c, a) => out(client().linkWalletMessage(client().accountId ?? '', c, a))));
chain.command('link <chain> <address> <signature>').description('link a wallet to your NEAR account').action(wrap(async (c, a, s) => out(client().linkWallet(c, a, s))));
chain.command('linked <caip10>').action(wrap(async (c) => out(client().linkedAccount(c))));
chain
  .command('attest-event')
  .description('verify an EVM log with Chain Signatures foreign-transaction verification and attest it')
  .requiredOption('--chain <chain>', 'ethereum, base, arbitrum, polygon, bnb, avalanche')
  .requiredOption('--tx <hash>')
  .requiredOption('--log-index <n>')
  .option('--log <json>', "the expected log in the contract's EvmLog shape (JSON or @file); read from the chain's public RPC when omitted")
  .option('--subject <subject>')
  .action(wrap(async (o) => out(client().attestForeignEvent({ chain: o.chain, txId: o.tx, logIndex: num(o.logIndex), log: parseJson(o.log, '--log'), subject: o.subject }))));

chain
  .command('attest-solana')
  .description('verify an inner instruction of a finalized Solana transaction (devnet on testnet) with the NEAR MPC network and attest it')
  .requiredOption('--tx <signature>', 'transaction signature (base58)')
  .requiredOption('--instruction <n>', 'index of the top-level instruction')
  .requiredOption('--inner <n>', "position among that instruction's inner instructions")
  .option('--subject <subject>')
  .action(wrap(async (o) => out(client().attestForeignInstruction({ txId: o.tx, instructionIndex: num(o.instruction), innerInstructionIndex: num(o.inner), subject: o.subject }))));

const agent = program.command('agent').description('Know Your Agent: identity, delegation, scoped access keys and reputation');
agent
  .command('register <agent>')
  .requiredOption('--name <name>')
  .requiredOption('--model <model>')
  .option('--capabilities <list>', 'comma-separated', '')
  .option('--endpoint <url>', '', '')
  .option('--description <text>', '', '')
  .action(
    wrap(async (a, o) =>
      out(client().registerAgent({ agent: a, name: o.name, model: o.model, capabilities: o.capabilities ? o.capabilities.split(',') : [], endpoint: o.endpoint, description: o.description })),
    ),
  );
agent
  .command('delegate <agent>')
  .option('--schemas <uids>')
  .option('--expires <unix>')
  .option('--max-uses <n>')
  .action(wrap(async (a, o) => out(client().delegateToAgent(a, { schemas: o.schemas?.split(','), expiresAt: o.expires ? num(o.expires) : undefined, maxUses: o.maxUses ? num(o.maxUses) : undefined }))));
agent
  .command('rate <agent> <score>')
  .option('--comment <text>')
  .option('--job <ref>')
  .action(wrap(async (a, s, o) => out(client().rateAgent({ agent: a, score: num(s), comment: o.comment, jobRef: o.job }))));
agent.command('profile <agent>').action(wrap(async (a) => out(client().getAgentProfile(a))));
agent
  .command('grant-key <publicKey>')
  .description('add a function-call access key the agent holds: only the attestations contract, only --methods, only --allowance of gas')
  .option('--methods <list>', `comma-separated (default ${AGENT_KEY_METHODS.join(',')}; allowed: ${AGENT_KEY_GRANTABLE_METHODS.join(', ')})`)
  .option('--allowance <near>', 'gas allowance in NEAR', AGENT_KEY_ALLOWANCE_NEAR)
  .action(wrap(async (k, o) => out(client().grantAgentKey(k, { methods: o.methods?.split(','), allowanceNear: o.allowance }))));
agent.command('revoke-key <publicKey>').description('delete an agent key from your account').action(wrap(async (k) => out(client().revokeAgentKey(k))));
agent.command('keys <account>').description("the account's agent keys for the attestations contract").action(wrap(async (a) => out(client().agentKeys(a))));

const pay = program.command('pay').description('paid verification over x402 (test token on testnet)');
pay.command('verify-claim <uid>').action(wrap(async (uid) => out(client().paidVerify('claim', uid))));
pay.command('verify-agent <agent>').action(wrap(async (a) => out(client().paidVerify('agent', a))));

// ─── data helpers ───────────────────────────────────────────────────────────
program
  .command('encode <definition> <values>')
  .description('encode values (JSON) for a definition; prints base64')
  .action(wrap(async (d, v) => out(Promise.resolve({ success: true, data: { data: new SchemaEncoder(d).encode(parseJson(v, 'values')!) } }))));
program
  .command('decode <definition> <data>')
  .description('decode base64 data with a definition')
  .action(wrap(async (d, data) => out(Promise.resolve({ success: true, data: new SchemaEncoder(d).decode(data) }))));
program
  .command('config')
  .description('show the resolved configuration')
  .action(
    wrap(async () => {
      const c = client();
      await out(Promise.resolve({ success: true, data: { network: c.network, account: c.accountId ?? null, contracts: c.contracts, rpc: c.config.rpcUrls[0] } }));
    }),
  );

// ─── ai ─────────────────────────────────────────────────────────────────────
program
  .command('ai <question...>')
  .description('ask the Attestra agent tools in natural language (NEAR AI Cloud, needs NEARAI_API_KEY)')
  .option('--model <model>', 'a verifiable model id (default: the first preferred one that is live)', process.env.NEARAI_MODEL)
  .option('--writes', 'allow tools that send transactions', false)
  .action(
    wrap(async (words: string[], o) => {
      const key = process.env.NEARAI_API_KEY;
      if (!key) throw new Error('set NEARAI_API_KEY (NEAR AI Cloud)');
      // Only verifiable models (they run inside a TEE); without --model, the first preferred one that is live.
      o.model = await pickVerifiableModel(o.model);
      const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: 'You answer questions about Attestra attestations on NEAR using the tools. Be brief and factual.' },
        { role: 'user', content: words.join(' ') },
      ];
      const tools = openAITools({ includeWrites: o.writes });
      for (let step = 0; step < 6; step++) {
        // A completion spends credits: retried only on answers that say it was not processed.
        const res = await fetchWithRetry(`${NEAR_AI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: o.model, messages, tools }),
        }, { write: true });
        if (!res.ok) throw new Error(`NEAR AI answered ${res.status}: ${await res.text()}`);
        const body = (await res.json()) as { id: string; choices: Array<{ message: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
        const msg = body.choices[0].message;
        messages.push(msg as Record<string, unknown>);
        if (!msg.tool_calls?.length) {
          await out(Promise.resolve({ success: true, data: { answer: msg.content ?? '', model: o.model, chat_id: body.id } }));
          return;
        }
        for (const call of msg.tool_calls) {
          const result = await runTool(client(), call.function.name, JSON.parse(call.function.arguments || '{}'), { allowWrites: o.writes });
          if (!json()) console.error(dim(`  ${orange('tool')} ${call.function.name}`));
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      throw new Error('the model kept calling tools; ask a narrower question');
    }),
  );

program.addHelpText('after', `\n${bold('Examples')}\n  ${dim('$')} attestra schema known\n  ${dim('$')} attestra attestation fetch <uid>\n  ${dim('$')} attestra events prove <uid>\n  ${dim('$')} attestra --account alice.testnet schema create -d "string name, u8 level" --revocable\n\nWell-known schemas: ${Object.keys(KNOWN_SCHEMAS).join(', ')}\n`);

program.parseAsync(process.argv).catch((e) => {
  console.error(formatOutput(undefined, false));
  fail('UNKNOWN_ERROR', (e as Error).message);
});

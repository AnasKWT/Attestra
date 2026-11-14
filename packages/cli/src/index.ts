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
  DEPLOYMENT_DAOS,
  KNOWN_SCHEMAS,
  NEAR_AI_BASE_URL,
  SchemaEncoder,
  computeSchemaUid,
  daoApprovalsNeeded,
  daoCan,
  daoCouncil,
  daoDelegateProposal,
  keySigner,
  knownSchemaUid,
  knownSchemas,
  fetchWithRetry,
  openAITools,
  nearToYocto,
  pickVerifiableModel,
  runTool,
  type MultisigAction,
  type ServiceResponse,
} from 'attestra';
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
  .command('list').description('list registered schemas from the indexer')
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
  .command('create').description('issue an attestation under a schema')
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
  .command('fetch <uid>').description('read an attestation with its decoded data and status')
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
  .command('list').description('list attestations from the indexer, filtered by schema, attester, subject or status')
  .option('--attester <account>')
  .option('--subject <subject>')
  .option('--schema <uid>')
  .option('--status <status>')
  .option('--limit <n>', 'max results', '25')
  .action(wrap(async (o) => out(client().listAttestations({ attester: o.attester, subject: o.subject, schemaUid: o.schema, status: o.status, limit: num(o.limit) }))));
attestation.command('revoke <uid>').description('revoke an attestation you issued').action(wrap(async (uid) => out(client().revokeAttestation(uid))));

// ─── authority ──────────────────────────────────────────────────────────────
const authority = program.command('authority').description('authorities (issuers)');
authority
  .command('register').description('register yourself as an authority with metadata')
  .requiredOption('-m, --metadata <text>', 'who you are')
  .option('-k, --kind <kind>', 'organization, person, agent, verifier or other')
  .action(wrap(async (o) => out(client().registerAuthority(o.metadata, o.kind))));
authority.command('fetch <account>').description('read an authority\'s record, verification and staking tier').action(wrap(async (a) => out(client().getAuthority(a))));
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
storage.command('balance <contract> <account>').description('an account\'s NEP-145 storage balance on a contract').action(wrap(async (c, a) => out(client().storageBalance(c, a))));
storage.command('withdraw <contract> [yocto]').description('withdraw unused storage deposit').action(wrap(async (c, amount) => out(client().storageWithdraw(c, amount))));

// ─── delegate ───────────────────────────────────────────────────────────────
const delegate = program.command('delegate').description('delegation: on-chain grants and NEP-413 signed requests');
delegate
  .command('add <delegate>').description('let another account attest for you, with a scope and an expiry')
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
delegate.command('remove <delegate>').description('remove a delegate').action(wrap(async (d) => out(client().removeDelegate(d))));
delegate.command('list <authority>').description('list an authority\'s delegates').action(wrap(async (a) => out(client().getDelegates(a))));
delegate.command('check <authority> <delegate>').description('is this account a delegate of that authority right now?').action(wrap(async (a, d) => out(client().isDelegate(a, d))));
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
delegate.command('keys <account>').description('the account\'s registered NEP-413 signer keys').action(wrap(async (a) => out(client().getSignerKeys(a))));
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
whitelist.command('add <schema> <account>').description('allow an attester under a schema').action(wrap(async (s, a) => out(client().whitelistAdd(s, a))));
whitelist.command('remove <schema> <account>').description('remove an attester from a schema').action(wrap(async (s, a) => out(client().whitelistRemove(s, a))));
whitelist.command('check <schema> <account>').description('is this attester allowed under that schema?').action(wrap(async (s, a) => out(client().whitelistCheck(s, a))));
whitelist.command('info').description("the whitelist resolver's kind and settings (resolver_info)").action(wrap(async () => out(client().resolverInfo(client().contracts.resolvers.whitelist))));

const fee = program.command('fee').description('fee resolver (NEAR or NEP-141, prepaid)');
fee.command('set-fee <schema> <amount>').description('set the fee a schema charges, in NEAR or a listed NEP-141 token').option('--token <account>', 'NEP-141 (default NEAR)').action(wrap(async (s, a, o) => out(client().feeSetFee(s, a, o.token))));
fee.command('get-fee <schema>').description('read a schema\'s fee').action(wrap(async (s) => out(client().feeGetFee(s))));
fee.command('deposit <amount>').description('prepay fees in NEAR or a NEP-141 token').option('--token <account>').action(wrap(async (a, o) => out(client().feeDeposit(a, o.token))));
fee.command('balance <account>').description('an account\'s prepaid fee balance').option('--token <account>').action(wrap(async (a, o) => out(client().feeGetBalance(a, o.token))));
fee.command('collected <schema>').description('fees a schema has collected').option('--token <account>').action(wrap(async (s, o) => out(client().feeCollected(s, o.token))));
fee.command('withdraw <schema>').description('schema admin takes collected fees').option('--token <account>').action(wrap(async (s, o) => out(client().feeWithdraw(s, o.token))));
fee.command('refund').description('take back unused prepaid balance').option('--token <account>').option('--amount <amount>').action(wrap(async (o) => out(client().feeWithdrawBalance(o.token, o.amount))));

const gated = program.command('token-gated').description('token-gated resolver (NEP-141 balance)');
gated.command('set-config <schema> <token> <minBalance>').description('gate a schema on a minimum NEP-141 balance').action(wrap(async (s, t, m) => out(client().tokenGatedSetConfig(s, t, m))));
gated.command('get-config <schema>').description('read a schema\'s token gate').action(wrap(async (s) => out(client().tokenGatedGetConfig(s))));

const reward = program.command('token-reward').description('token reward resolver (pays NEP-141 to subjects)');
reward.command('set-config <schema> <token> <amount>').description('pay a NEP-141 reward to the subject of each attestation').action(wrap(async (s, t, a) => out(client().tokenRewardSetConfig(s, t, a))));
reward.command('fund <schema> <token> <amount>').description('fund a schema\'s reward pool').action(wrap(async (s, t, a) => out(client().tokenRewardFund(s, t, a))));
reward.command('get-config <schema>').description('read a schema\'s reward settings').action(wrap(async (s) => out(client().tokenRewardGetConfig(s))));
reward.command('distributed <schema> <account>').description('rewards an account has received under a schema').action(wrap(async (s, a) => out(client().tokenRewardGetDistributed(s, a))));

const pipeline = program.command('pipeline').alias('cross-contract').description('pipeline resolver (chained cross-contract resolvers)');
pipeline.command('set <schema> <resolvers>').description('resolvers comma-separated, in order').action(wrap(async (s, r) => out(client().pipelineSetResolvers(s, r.split(',')))));
pipeline.command('get <schema>').action(wrap(async (s) => out(client().pipelineGetResolvers(s))));

// ─── credential ─────────────────────────────────────────────────────────────
const credential = program.command('credential').description('NEP-171 non-transferable credentials');
credential.command('mint <attestationUid>').description('mint the non-transferable NEP-171 credential for an attestation').action(wrap(async (u) => out(client().mintCredential(u))));
credential.command('fetch <attestationUid>').description('read an attestation\'s credential').action(wrap(async (u) => out(client().getCredential(u))));
credential.command('list <owner>').description('list an account\'s credentials').action(wrap(async (o) => out(client().listCredentials(o))));

// ─── schedule ───────────────────────────────────────────────────────────────
const schedule = program.command('schedule').description('scheduled revocations');
schedule
  .command('revoke <uid>').description('schedule a revocation for a later time')
  .option('--at <unix>', 'revoke at (unix seconds)')
  .option('--in <seconds>', 'revoke in N seconds')
  .action(
    wrap(async (uid, o) => {
      const at = o.at ? num(o.at) : Math.floor(Date.now() / 1000) + num(o.in ?? '3600');
      await out(client().scheduleRevocation(uid, at));
    }),
  );
schedule.command('status <uid>').description('an attestation\'s scheduled revocation, if any').action(wrap(async (uid) => out(client().getScheduledRevocation(uid))));
schedule.command('finalize <uid>').description('record a scheduled revocation that is due').action(wrap(async (uid) => out(client().finalizeRevocation(uid))));

// ─── multisig ───────────────────────────────────────────────────────────────
const multisig = program.command('multisig').description('k-of-n multisig authorities');
multisig
  .command('create').description('create a k-of-n multisig authority')
  .requiredOption('--members <accounts>', 'comma-separated')
  .requiredOption('--threshold <k>')
  .requiredOption('-m, --metadata <text>')
  .action(wrap(async (o) => out(client().createMultisigAuthority({ members: o.members.split(','), threshold: num(o.threshold), metadata: o.metadata }))));
multisig
  .command('propose-attest <multisig>').description('propose an attestation for the multisig to approve')
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
multisig.command('propose-revoke <multisig> <uid>').description('propose a revocation for the multisig to approve').action(wrap(async (ms, uid) => out(client().proposeMultisig(ms, { type: 'revoke', uid }))));
multisig.command('approve <proposalId>').description('approve a proposal as a member').action(wrap(async (id) => out(client().approveMultisig(num(id)))));
multisig.command('execute <proposalId>').description('execute a proposal that reached its threshold').action(wrap(async (id) => out(client().executeMultisig(num(id)))));
multisig.command('cancel <proposalId>').description('cancel a proposal you made').action(wrap(async (id) => out(client().cancelMultisig(num(id)))));
multisig.command('fetch <multisig>').description('read a multisig\'s members and threshold').action(wrap(async (id) => out(client().getMultisig(id))));
multisig.command('proposal <proposalId>').description('read a proposal and its approvals').action(wrap(async (id) => out(client().getProposal(num(id)))));

// ─── Sputnik DAO attesters ──────────────────────────────────────────────────
const dao = program.command('dao').description('Sputnik DAO attesters: a DAO issues attestations by proposal and council vote');
const daoId = (o: { dao?: string }) => {
  const id = o.dao ?? DEPLOYMENT_DAOS[client().config.network];
  if (!id) throw new Error('name the DAO with --dao <account>');
  return id;
};
const daoOpt = '--dao <account>';
const daoHelp = 'the DAO (default: the deployment DAO, attestra.sputnik-v2.testnet on testnet)';
dao
  .command('info').description('a DAO\'s name, purpose, council, approvals needed and proposal bond')
  .option(daoOpt, daoHelp)
  .action(
    wrap(async (o) => {
      const id = daoId(o);
      const [config, policy] = await Promise.all([client().getDaoConfig(id), client().getDaoPolicy(id)]);
      if (!policy.success) return out(Promise.resolve(policy));
      const pol = policy.data!;
      // Every named role that can approve a function call: its members, the votes that decide one, and whether it can vote on anything else.
      const voters = pol.roles.flatMap((r) =>
        typeof r.kind === 'object' && 'Group' in r.kind && daoCouncil({ ...pol, roles: [r] }).length
          ? [{ role: r.name, members: r.kind.Group, approvals: daoApprovalsNeeded(pol, r), only_function_calls: !r.permissions.some((p) => p.startsWith('*:')) }]
          : [],
      );
      await out(Promise.resolve({ success: true, data: { dao: id, name: config.data?.name, purpose: config.data?.purpose, voters, proposal_bond_near: Number(BigInt(pol.proposal_bond)) / 1e24, anyone_can_propose: daoCan(pol, 'anyone.near', 'AddProposal') } }));
    }),
  );
dao
  .command('propose-attest').description('propose that the DAO issue an attestation (it becomes the attester once the council approves)')
  .option(daoOpt, daoHelp)
  .requiredOption('-s, --schema <uid>')
  .requiredOption('--subject <subject>')
  .option('-v, --values <json>')
  .option('--data <base64>')
  .option('--expires <unix>', 'expiration time, unix seconds')
  .option('-d, --description <text>')
  .action(wrap(async (o) => out(client().proposeDaoAttestation(daoId(o), { schemaUid: o.schema, subject: o.subject, data: await encodeData(o.schema, o.values, o.data), expirationTime: o.expires ? num(o.expires) : undefined, description: o.description }))));
dao
  .command('propose-membership').description('ask the DAO for a membership attestation about yourself (the keeper approves member and contributor)')
  .option(daoOpt, daoHelp)
  .option('-r, --role <role>', 'member, contributor, or a role the human council decides', 'member')
  .action(
    wrap(async (o) => {
      const id = daoId(o);
      const me = client().accountId;
      if (!me) throw new Error('set an account to propose as (--account or ATTESTRA_ACCOUNT_ID)');
      const data = new SchemaEncoder(KNOWN_SCHEMAS.membership.definition).encode({ organization: id, role: o.role, since: Math.floor(Date.now() / 1000) });
      await out(client().proposeDaoAttestation(id, { schemaUid: knownSchemaUid('membership'), subject: me, data, description: `Membership: ${me} as ${o.role}` }));
    }),
  );
dao
  .command('request-membership').description('ask the DAO\'s membership desk (its delegate under a grant the council voted) to admit your account; you sign the request')
  .option(daoOpt, daoHelp)
  .option('-r, --role <role>', 'member or contributor; other roles go to the council with propose-membership', 'member')
  .action(wrap(async (o) => out(client().requestDaoMembership({ dao: daoId(o), role: o.role }))));
dao
  .command('grant-desk <delegate>').description('propose that the DAO let a delegate issue one schema on its behalf (a scoped Attestra delegate grant the council votes)')
  .option(daoOpt, daoHelp)
  .option('-s, --schema <uid>', 'the schema the delegate may issue', knownSchemaUid('membership'))
  .option('--uses <n>', 'most attestations it may issue', '1000')
  .option('--days <n>', 'how long the grant lasts', '120')
  .action(
    wrap(async (delegate, o) =>
      out(client().addDaoProposal(daoId(o), daoDelegateProposal(client().contracts.attestations, delegate, { schemas: [o.schema], maxUses: num(o.uses), expiresAt: Math.floor(Date.now() / 1000) + num(o.days) * 86_400 }))),
    ),
  );
dao
  .command('propose-revoke <uid>').description('propose that the DAO revoke an attestation it issued')
  .option(daoOpt, daoHelp)
  .option('-d, --description <text>')
  .action(wrap(async (uid, o) => out(client().proposeDaoRevocation(daoId(o), uid, { description: o.description }))));
dao
  .command('vote <proposalId>').description('vote as a council member; a deciding approval runs the DAO\'s call in the same transaction')
  .option(daoOpt, daoHelp)
  .option('--reject', 'vote to reject')
  .option('--remove', 'vote to remove (spam; the bond is kept)')
  .option('--memo <text>')
  .action(wrap(async (id, o) => out(client().voteDaoProposal(daoId(o), num(id), o.remove ? 'VoteRemove' : o.reject ? 'VoteReject' : 'VoteApprove', o.memo))));
dao
  .command('proposals').description('the newest proposals, each with the attestation call it makes')
  .option(daoOpt, daoHelp)
  .option('-l, --limit <n>', 'how many', '10')
  .action(wrap(async (o) => out(client().getDaoProposals(daoId(o), { limit: num(o.limit) }))));
dao.command('proposal <proposalId>').description('one proposal: status, votes and its attestation call').option(daoOpt, daoHelp).action(wrap(async (id, o) => out(client().getDaoProposal(daoId(o), num(id)))));
dao
  .command('fund <near>').description('add to the DAO\'s storage balance on the attestations contract, which pays for what it issues')
  .option(daoOpt, daoHelp)
  .action(wrap(async (near, o) => out(client().fundDaoStorage(daoId(o), nearToYocto(near)))));
dao
  .command('create <name>').description('create a Sputnik DAO that issues attestations: anyone proposes, the council approves (about 6 NEAR)')
  .requiredOption('--council <accounts>', 'comma-separated; the council may vote on anything')
  .option('--approvals <k>', 'council votes a proposal needs', '1')
  .option('--purpose <text>', 'what the DAO attests', 'Issues attestations its council approves.')
  .action(wrap(async (name, o) => out(client().createSputnikDao({ name, purpose: o.purpose, council: o.council.split(',').map((a: string) => a.trim()).filter(Boolean), approvals: num(o.approvals) }))));

// ─── staking and the test token ─────────────────────────────────────────────
const staking = program.command('staking').description('authority staking tiers (NEP-141)');
staking.command('stake <amount>').description('amount in the smallest unit').action(wrap(async (a) => out(client().stake(a))));
staking.command('unstake <amount>').description('withdraw staked tokens').action(wrap(async (a) => out(client().unstake(a))));
staking.command('info <account>').description('an account\'s stake and tier').action(wrap(async (a) => out(client().getStake(a))));
staking.command('tiers').description('the stake each tier needs').action(wrap(async () => out(client().getTiers())));
const token = program.command('token').description('the testnet test token');
token.command('faucet').description('1,000 test tokens, once an hour').action(wrap(async () => out(client().faucet())));
token.command('balance <account>').description('an account\'s test token balance').action(wrap(async (a) => out(client().tokenBalance(a))));

// ─── events (audit trail) ───────────────────────────────────────────────────
const events = program.command('events').description('NEP-297 audit trail and light client proofs');
events
  .command('list').description('list protocol events from the indexer')
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
  .command('prove-receipt <receiptId> <receiver>').description('prove any receipt final with a light client proof')
  .action(wrap(async (r, recv) => out(client().proveReceipt(r, recv))));

// ─── only on NEAR ───────────────────────────────────────────────────────────
const check = program.command('check').description('private facts checked by verifiable AI (NEAR AI Cloud + enclave)');
check
  .command('run <ruleId>').description('run a private AI check about your own account: you sign the request, the evidence is encrypted to the model, the verdict is attested on chain')
  .option('--subject <subject>', 'defaults to your account (the check is signed with its key)')
  .option('--evidence <text>', 'private evidence (or @file)')
  .option('--github <login>', 'GitHub login for github_contributor')
  .action(
    wrap(async (rule, o) => {
      const evidence = o.evidence?.startsWith('@') ? readFileSync(o.evidence.slice(1), 'utf8') : (o.evidence ?? '');
      const subject = o.subject ?? client().accountId;
      if (!subject) throw new Error('set an account: a check is about, and signed by, its subject');
      await out(client().requestPrivateCheck({ ruleId: rule, subject, evidence, github: o.github }));
    }),
  );
check.command('rules').description('the private-check rules the verdicts contract accepts').action(wrap(async () => out(client().verdictsConfig())));

const chain = program.command('chain').description('facts about other chains, without an oracle');
chain
  .command('link-message <chain> <address>')
  .description('chain is eip155 or solana; prints the text the wallet signs')
  .action(wrap(async (c, a) => out(client().linkWalletMessage(client().accountId ?? '', c, a))));
chain.command('link <chain> <address> <signature>').description('link a wallet to your NEAR account').action(wrap(async (c, a, s) => out(client().linkWallet(c, a, s))));
chain.command('linked <caip10>').description('the NEAR account a wallet on another chain is linked to').action(wrap(async (c) => out(client().linkedAccount(c))));
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
  .command('register <agent>').description('register an agent you own: an identity attestation with its model, capabilities and endpoint')
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
  .command('delegate <agent>').description('delegate to an agent with a scope and an expiry, so it can attest for you')
  .option('--schemas <uids>')
  .option('--expires <unix>')
  .option('--max-uses <n>')
  .action(wrap(async (a, o) => out(client().delegateToAgent(a, { schemas: o.schemas?.split(','), expiresAt: o.expires ? num(o.expires) : undefined, maxUses: o.maxUses ? num(o.maxUses) : undefined }))));
agent
  .command('rate <agent> <score>').description('rate an agent you hired: a review attestation with a score from 1 to 5')
  .option('--comment <text>')
  .option('--job <tx-hash>', 'the transaction hash of your payment to the agent; only then the review counts as paid')
  .action(wrap(async (a, s, o) => out(client().rateAgent({ agent: a, score: num(s), comment: o.comment, jobRef: o.job }))));
agent.command('profile <agent>').description('an agent\'s identity, reviews, average score and delegations').action(wrap(async (a) => out(client().getAgentProfile(a))));
agent
  .command('grant-key <publicKey>')
  .description('add a function-call access key the agent holds: only the attestations contract, only --methods, only --allowance of gas')
  .option('--methods <list>', `comma-separated (default ${AGENT_KEY_METHODS.join(',')}; allowed: ${AGENT_KEY_GRANTABLE_METHODS.join(', ')})`)
  .option('--allowance <near>', 'gas allowance in NEAR', AGENT_KEY_ALLOWANCE_NEAR)
  .action(wrap(async (k, o) => out(client().grantAgentKey(k, { methods: o.methods?.split(','), allowanceNear: o.allowance }))));
agent.command('revoke-key <publicKey>').description('delete an agent key from your account').action(wrap(async (k) => out(client().revokeAgentKey(k))));
agent.command('keys <account>').description("the account's agent keys for the attestations contract").action(wrap(async (a) => out(client().agentKeys(a))));

const pay = program.command('pay').description('paid verification over x402 (test token on testnet)');
pay.command('verify-claim <uid>').description('pay the agent over x402 to verify a claim and prove its event final').action(wrap(async (uid) => out(client().paidVerify('claim', uid))));
pay.command('verify-agent <agent>').description('pay the agent over x402 to check an agent\'s identity and reputation').action(wrap(async (a) => out(client().paidVerify('agent', a))));

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
      const r = resolveConfig(program.opts() as CliOptions);
      await out(Promise.resolve({ success: true, data: { network: c.network, account: c.accountId ?? null, contracts: c.contracts, rpc: c.config.rpcUrls[0], indexer: r.indexerUrl, relayer: r.relayerUrl, agent: r.agentUrl } }));
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

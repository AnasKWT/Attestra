/**
 * The Sputnik DAO that issues membership attestations on a deployment.
 *
 *   pnpm dao setup [testnet]   create the DAO (idempotent), set its policy, have the council grant the keeper a scoped
 *                              delegate grant, fund its storage on the attestations contract, record it in deployments/
 *   pnpm dao demo [testnet]    the council way: the treasury proposes its own membership and the council (the root) votes
 *                              it through, so the DAO attests; the transactions are recorded in deployments/
 *
 * Reads TREASURY_ACCOUNT_ID/TREASURY_PRIVATE_KEY and KEEPER_ACCOUNT_ID (the services env file), and the root's key from
 * ~/.near-credentials. DAO_NAME sets the name (default `attestra`).
 * The deployment root is the council, with every power. The keeper holds no role in the DAO: the council votes it an
 * Attestra delegate grant (membership schema only, a use limit, an expiry), and the attestations contract enforces it,
 * so the keeper's key can issue memberships as the DAO and nothing else. `setup` moves an existing DAO to this policy
 * with a ChangePolicy proposal and renews the grant when it is missing or near its end.
 *
 * #mainnet: refuses mainnet unless ATTESTRA_MAINNET_GO names the root, like the deploy script.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Near } from 'near-kit';
import { FileKeyStore } from 'near-kit/keys/file';
import { AttestraClient, KNOWN_SCHEMAS, SchemaEncoder, SPUTNIK_FACTORIES, attestingDaoPolicy, daoCouncil, daoDelegateProposal, daoPolicyProposal, knownSchemaUid, type DaoPolicy, type Network } from 'attestra';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd = 'setup', netArg = 'testnet'] = process.argv.slice(2);
const NET = netArg as Network;
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const NEAR = 10n ** 24n;
/** Storage balance the DAO keeps on the attestations contract: a membership attestation takes about 3 milliNEAR. */
const STORAGE_TARGET = NEAR / 2n;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (run with the services env file)`);
  return v;
}

function unwrap<T>(r: { success: boolean; data?: T; error?: { message: string }; txHash?: string }, what: string): T {
  if (!r.success) throw new Error(`${what}: ${r.error?.message}`);
  if (r.txHash) log(`${what}: tx ${r.txHash}`);
  return r.data as T;
}

async function main() {
  if (NET !== 'testnet' && NET !== 'mainnet') throw new Error('network is testnet or mainnet');
  const root = process.env.ATTESTRA_ROOT || (NET === 'testnet' ? 'attestra.testnet' : 'attestra.near');
  if (NET === 'mainnet' && process.env.ATTESTRA_MAINNET_GO !== root) throw new Error(`mainnet needs ATTESTRA_MAINNET_GO=${root}`);
  const file = join(repo, 'deployments', `${NET}.json`);
  const deployment = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & { dao?: Record<string, unknown> };
  const name = process.env.DAO_NAME || 'attestra';
  const dao = `${name}.${SPUTNIK_FACTORIES[NET]}`;
  const treasury = new AttestraClient({ network: NET, root, accountId: need('TREASURY_ACCOUNT_ID'), privateKey: need('TREASURY_PRIVATE_KEY') });
  const keeper = need('KEEPER_ACCOUNT_ID');
  const save = (patch: Record<string, unknown>) => {
    deployment.dao = { ...(deployment.dao ?? {}), ...patch };
    writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
  };

  const rootClient = () => new AttestraClient({ network: NET, root, accountId: root, near: new Near({ network: NET, keyStore: new FileKeyStore(join(homedir(), '.near-credentials'), NET) }) });
  /** The root proposes and its one council vote passes it. */
  const councilPasses = async (proposal: Parameters<AttestraClient['addDaoProposal']>[1], what: string) => {
    const c = rootClient();
    const p = unwrap(await c.addDaoProposal(dao, proposal), `propose ${what}`);
    const v = await c.voteDaoProposal(dao, p.proposalId, 'VoteApprove', what);
    const r = unwrap(v, `approve ${what} (proposal ${p.proposalId})`);
    if (r.status !== 'Approved') throw new Error(`${what} ended ${r.status}${r.failure ? `: ${r.failure}` : ''}`);
    return { proposalId: p.proposalId, tx: v.txHash ?? '' };
  };

  if (cmd === 'setup') {
    const BOND = 10n ** 22n;
    const wanted = attestingDaoPolicy([root], { approvals: 1, proposalBond: BOND });
    const sameRoles = (p: DaoPolicy) => JSON.stringify(p.roles) === JSON.stringify(wanted.roles) && JSON.stringify(p.default_vote_policy) === JSON.stringify(wanted.default_vote_policy);
    const existing = await treasury.getDaoPolicy(dao);
    let createdTx = (deployment.dao?.created_tx as string | undefined) ?? null;
    let policyTx = (deployment.dao?.policy_tx as string | undefined) ?? null;
    if (existing.success) {
      log(`${dao} exists; council ${daoCouncil(existing.data!).join(', ')}`);
      if (!sameRoles(existing.data!)) policyTx = (await councilPasses(daoPolicyProposal(wanted, 'Only the council votes; automated issuing goes through a scoped Attestra delegate grant'), 'the policy')).tx;
    } else {
      const r = await treasury.createSputnikDao({
        name,
        purpose: 'Issues Attestra membership attestations to the people its council approves, by proposal and vote, and through a delegate grant the council voted.',
        council: [root],
        approvals: 1,
        proposalBond: BOND,
      });
      unwrap(r, `create ${dao}`);
      createdTx = r.txHash ?? null;
    }
    const balance = await treasury.view<{ total: string; available: string } | null>(treasury.contracts.attestations, 'storage_balance_of', { account_id: dao });
    const have = BigInt(balance?.available ?? '0');
    if (have < STORAGE_TARGET / 2n) unwrap(await treasury.fundDaoStorage(dao, STORAGE_TARGET - have), `storage for ${dao}`);
    else log(`${dao} storage available ${Number(have) / 1e24} NEAR`);

    // The keeper's grant: membership only, at most 1000 uses, for 120 days; renewed when missing or under 30 days left.
    const now = Math.floor(Date.now() / 1000);
    const grant = await treasury.view<{ expires_at: number; max_uses: number; uses: number } | null>(treasury.contracts.attestations, 'get_delegate', { authority: dao, delegate: keeper });
    let grantTx = (deployment.dao?.grant_tx as string | undefined) ?? null;
    let grantProposal = (deployment.dao?.grant_proposal as number | undefined) ?? null;
    if (!grant || grant.expires_at - now < 30 * 86_400 || grant.uses >= grant.max_uses) {
      const g = await councilPasses(
        daoDelegateProposal(treasury.contracts.attestations, keeper, { schemas: [knownSchemaUid('membership')], expiresAt: now + 120 * 86_400, maxUses: 1000, label: 'membership desk' }, `Let ${keeper} issue membership attestations on behalf of the DAO (membership schema only, 1000 uses, 120 days)`),
        'the keeper grant',
      );
      grantTx = g.tx;
      grantProposal = g.proposalId;
    } else log(`${keeper} holds a grant until ${new Date(grant.expires_at * 1000).toISOString().slice(0, 10)}, ${grant.uses} of ${grant.max_uses} uses`);

    const policy = unwrap(await treasury.getDaoPolicy(dao), 'policy');
    const { reviewers: _old, ...kept } = (deployment.dao ?? {}) as Record<string, unknown>;
    deployment.dao = kept;
    save({
      account: dao,
      factory: SPUTNIK_FACTORIES[NET],
      council: daoCouncil(policy),
      approvals: 1,
      proposal_bond: policy.proposal_bond,
      schema: knownSchemaUid('membership'),
      delegate: keeper,
      ...(grantProposal !== null ? { grant_proposal: grantProposal } : {}),
      ...(grantTx ? { grant_tx: grantTx } : {}),
      ...(createdTx ? { created_tx: createdTx } : {}),
      ...(policyTx ? { policy_tx: policyTx } : {}),
    });
    log(`recorded ${dao} in deployments/${NET}.json`);
    return;
  }

  if (cmd === 'demo') {
    const proposer = treasury.accountId!;
    const encoder = new SchemaEncoder(KNOWN_SCHEMAS.membership.definition);
    const data = encoder.encode({ organization: dao, role: 'contributor', since: Math.floor(Date.now() / 1000) });
    const propose = await treasury.proposeDaoAttestation(dao, { schemaUid: knownSchemaUid('membership'), subject: proposer, data, description: `Membership: ${proposer} as contributor` });
    const proposed = unwrap(propose, `propose on ${dao}`);
    const vote = await rootClient().voteDaoProposal(dao, proposed.proposalId, 'VoteApprove', 'the council admits a contributor');
    const result = unwrap(vote, `approve proposal ${proposed.proposalId}`);
    if (result.status !== 'Approved' || !result.attestationUid) throw new Error(`the proposal ended ${result.status}: ${result.failure ?? 'no attestation event'}`);
    const a = unwrap(await treasury.getAttestation(result.attestationUid), 'read attestation');
    if (a.attester !== dao) throw new Error(`attester is ${a.attester}, expected ${dao}`);
    log(`attestation ${result.attestationUid} by ${a.attester} about ${a.subject}: ${JSON.stringify(encoder.decode(a.data))}`);
    save({ example: { proposal_id: proposed.proposalId, proposer, propose_tx: propose.txHash, vote_tx: vote.txHash, attestation: result.attestationUid } });
    return;
  }
  throw new Error(`unknown command ${cmd}: setup or demo`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

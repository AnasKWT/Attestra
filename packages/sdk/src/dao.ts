/**
 * Sputnik DAO v2 as an attester. A DAO issues and revokes attestations through ordinary
 * `FunctionCall` proposals that its council votes on; when one passes, the DAO account itself calls
 * the attestations contract, so the attestation's attester is the DAO.
 *
 * These helpers are pure: they build proposals, read them back, and answer what a policy lets an
 * account do. `AttestraClient` sends and reads them (`proposeDaoAttestation`, `voteDaoProposal`).
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base64ToBytes, bytesToBase64, bytesToHex } from './borsh';
import { nep413Hash, randomNonce, type MessageSigner } from './nep413';
import type { Network } from './types';
import { normalizeUid } from './uid';

const TGAS = 1_000_000_000_000n;

/** The Sputnik DAO v2 factory per network; DAOs it creates are `<name>.<factory>`. */
export const SPUTNIK_FACTORIES: Record<Network, string> = { testnet: 'sputnik-v2.testnet', mainnet: 'sputnik-dao.near' };

/** The DAO a deployment runs for membership attestations (`pnpm dao setup`); none on mainnet yet. */
export const DEPLOYMENT_DAOS: Record<Network, string | null> = { testnet: 'attestra.sputnik-v2.testnet', mainnet: null };

/** Gas the DAO gives its call to the attestations contract: an attest under a resolver pipeline fits. */
export const DAO_ACTION_GAS = 150n * TGAS;
/** The most gas a proposal action may ask for, so `act_proposal` at 300 Tgas still has room to run it. */
export const DAO_MAX_ACTION_GAS = 250n * TGAS;
/** Deposit the factory asks for a new DAO: its code and state take about 4.7 NEAR of storage. */
export const DAO_CREATE_DEPOSIT = 6n * 10n ** 24n;

export type DaoVote = 'VoteApprove' | 'VoteReject' | 'VoteRemove';
export type DaoProposalStatus = 'InProgress' | 'Approved' | 'Rejected' | 'Removed' | 'Expired' | 'Moved' | 'Failed';

export interface DaoActionCall {
  method_name: string;
  /** JSON arguments, base64. */
  args: string;
  deposit: string;
  gas: string;
}

export interface DaoFunctionCall {
  FunctionCall: { receiver_id: string; actions: DaoActionCall[] };
}

/** A proposal kind; only `FunctionCall` is typed, the others pass through as the DAO returns them. */
export type DaoProposalKind = DaoFunctionCall | Record<string, unknown> | string;

export interface DaoProposalInput {
  description: string;
  kind: DaoProposalKind;
}

export interface DaoProposal {
  id: number;
  proposer: string;
  description: string;
  kind: DaoProposalKind;
  status: DaoProposalStatus;
  /** Per role: approve, reject and remove weights. */
  vote_counts: Record<string, Array<string | number>>;
  votes: Record<string, 'Approve' | 'Reject' | 'Remove'>;
  /** Nanoseconds. */
  submission_time: string;
}

export interface DaoVotePolicy {
  weight_kind: 'RoleWeight' | 'TokenWeight';
  quorum: string;
  /** A fixed weight (`"1"`) or a ratio (`[1, 2]`) of the role's size. */
  threshold: string | [number, number];
}

export interface DaoRole {
  name: string;
  kind: 'Everyone' | { Group: string[] } | { Member: string };
  permissions: string[];
  vote_policy: Record<string, DaoVotePolicy>;
}

export interface DaoPolicy {
  roles: DaoRole[];
  default_vote_policy: DaoVotePolicy;
  proposal_bond: string;
  /** Nanoseconds. */
  proposal_period: string;
  bounty_bond: string;
  bounty_forgiveness_period: string;
}

export interface DaoConfig {
  name: string;
  purpose: string;
  /** Base64. */
  metadata: string;
}

/** What a DAO attestation proposal asks the attestations contract to do. */
export interface DaoAttestRequest {
  schemaUid: string;
  subject: string;
  /** Borsh-encoded data, base64 (`SchemaEncoder.encode`). */
  data: string;
  expirationTime?: number;
  refUid?: string;
}

/** A proposal's call to the attestations contract, read back. */
export type ParsedDaoCall =
  | { method: 'attest'; schemaUid: string; subject: string; data: string; expirationTime: number | null; refUid: string | null; deposit: string; gas: string }
  | { method: 'revoke'; uid: string; deposit: string; gas: string };

function toBase64Json(value: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

function actionGas(gas: bigint | undefined): string {
  const g = gas ?? DAO_ACTION_GAS;
  if (g <= 0n || g > DAO_MAX_ACTION_GAS) throw new Error(`action gas must be between 1 and ${DAO_MAX_ACTION_GAS / TGAS} Tgas`);
  return g.toString();
}

/** A `FunctionCall` proposal that, once approved, makes the DAO attest. Its storage balance pays. */
export function daoAttestProposal(attestations: string, p: DaoAttestRequest & { description?: string; gas?: bigint }): DaoProposalInput {
  const args = {
    schema_uid: normalizeUid(p.schemaUid),
    subject: p.subject,
    data: p.data,
    expiration_time: p.expirationTime || null,
    ref_uid: p.refUid ? normalizeUid(p.refUid) : null,
  };
  return {
    description: p.description ?? `Attest ${p.subject} under schema ${args.schema_uid.slice(0, 12)}…`,
    kind: { FunctionCall: { receiver_id: attestations, actions: [{ method_name: 'attest', args: toBase64Json(args), deposit: '0', gas: actionGas(p.gas) }] } },
  };
}

/** A `FunctionCall` proposal that, once approved, makes the DAO revoke an attestation it issued. */
export function daoRevokeProposal(attestations: string, uid: string, p: { description?: string; gas?: bigint } = {}): DaoProposalInput {
  const u = normalizeUid(uid);
  return {
    description: p.description ?? `Revoke attestation ${u.slice(0, 12)}…`,
    kind: { FunctionCall: { receiver_id: attestations, actions: [{ method_name: 'revoke', args: toBase64Json({ uid: u }), deposit: '0', gas: actionGas(p.gas) }] } },
  };
}

function functionCallOf(kind: DaoProposalKind): DaoFunctionCall['FunctionCall'] | null {
  if (!kind || typeof kind !== 'object' || !('FunctionCall' in kind)) return null;
  const fc = (kind as DaoFunctionCall).FunctionCall;
  return fc && typeof fc.receiver_id === 'string' && Array.isArray(fc.actions) ? fc : null;
}

/**
 * The single attest or revoke call a proposal makes on `attestations`, or null when the proposal
 * is anything else (another kind, another receiver, several actions, unreadable arguments).
 */
export function parseDaoCall(kind: DaoProposalKind, attestations: string): ParsedDaoCall | null {
  const fc = functionCallOf(kind);
  if (!fc || fc.receiver_id !== attestations || fc.actions.length !== 1) return null;
  const a = fc.actions[0];
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(new TextDecoder().decode(base64ToBytes(a.args))) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!args || typeof args !== 'object') return null;
  try {
    if (a.method_name === 'attest' && typeof args.subject === 'string' && typeof args.data === 'string') {
      const exp = args.expiration_time;
      return {
        method: 'attest',
        schemaUid: normalizeUid(String(args.schema_uid)),
        subject: args.subject,
        data: args.data,
        expirationTime: typeof exp === 'number' && exp > 0 ? exp : null,
        refUid: typeof args.ref_uid === 'string' ? normalizeUid(args.ref_uid) : null,
        deposit: String(a.deposit),
        gas: String(a.gas),
      };
    }
    if (a.method_name === 'revoke' && typeof args.uid === 'string') {
      return { method: 'revoke', uid: normalizeUid(args.uid), deposit: String(a.deposit), gas: String(a.gas) };
    }
  } catch {
    return null;
  }
  return null;
}

/** True when the account is a DAO from the network's Sputnik factory (by its name). */
export function isSputnikDao(accountId: string, network?: Network): boolean {
  const factories = network ? [SPUTNIK_FACTORIES[network]] : Object.values(SPUTNIK_FACTORIES);
  return factories.some((f) => accountId.endsWith(`.${f}`) && accountId.length > f.length + 1 && !accountId.slice(0, -f.length - 1).includes('.'));
}

function inRole(role: DaoRole, account: string): boolean {
  if (role.kind === 'Everyone') return true;
  if (typeof role.kind === 'object' && 'Group' in role.kind) return role.kind.Group.includes(account);
  // Token-weighted members depend on the DAO's staking contract; not decided from the policy alone.
  return false;
}

function allows(role: DaoRole, label: string, action: string): boolean {
  return role.permissions.some((p) => p === '*:*' || p === `${label}:*` || p === `*:${action}` || p === `${label}:${action}`);
}

/** Whether a policy lets `account` take `action` (`AddProposal`, `VoteApprove`, ...) on proposals labelled `label` (`call` for function calls). */
export function daoCan(policy: DaoPolicy, account: string, action: string, label = 'call'): boolean {
  return policy.roles.some((r) => inRole(r, account) && allows(r, label, action));
}

/** The named members who can approve function-call proposals. */
export function daoCouncil(policy: DaoPolicy, label = 'call'): string[] {
  const out = new Set<string>();
  for (const r of policy.roles) {
    if (typeof r.kind === 'object' && 'Group' in r.kind && allows(r, label, 'VoteApprove')) for (const m of r.kind.Group) out.add(m);
  }
  return [...out];
}

/** Approvals a function-call proposal needs from a group role, by Sputnik's own rule. */
export function daoApprovalsNeeded(policy: DaoPolicy, role: DaoRole, label = 'call'): number | null {
  if (typeof role.kind !== 'object' || !('Group' in role.kind)) return null;
  const vp = role.vote_policy[label] ?? policy.default_vote_policy;
  if (vp.weight_kind !== 'RoleWeight') return null;
  const size = role.kind.Group.length;
  const threshold = Array.isArray(vp.threshold) ? Math.min(Math.floor((vp.threshold[0] * size) / vp.threshold[1]) + 1, size) : Number(vp.threshold);
  return Math.max(Number(vp.quorum), threshold);
}

/**
 * A policy for a DAO that issues attestations: anyone may propose a function call (with the bond),
 * the council approves with `approvals` votes and may do everything else. Automated issuing goes
 * through an Attestra delegate grant the council votes (`daoDelegateProposal`), never through a
 * voting role: a Sputnik role that may approve function calls could approve any call.
 */
export function attestingDaoPolicy(council: string[], opts: { approvals?: number; proposalBond?: bigint; proposalPeriodDays?: number } = {}): DaoPolicy {
  if (!council.length) throw new Error('the council needs at least one member');
  const approvals = opts.approvals ?? 1;
  if (approvals < 1 || approvals > council.length) throw new Error(`approvals must be between 1 and ${council.length}`);
  const DAY_NS = 86_400n * 10n ** 9n;
  return {
    roles: [
      { name: 'all', kind: 'Everyone', permissions: ['call:AddProposal'], vote_policy: {} },
      { name: 'council', kind: { Group: council }, permissions: ['*:*'], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: String(approvals) },
    proposal_bond: (opts.proposalBond ?? 10n ** 22n).toString(),
    proposal_period: (BigInt(opts.proposalPeriodDays ?? 7) * DAY_NS).toString(),
    bounty_bond: (10n ** 24n).toString(),
    bounty_forgiveness_period: DAY_NS.toString(),
  };
}

/** The scope a DAO gives a delegate that issues on its behalf (`add_delegate` on the attestations contract). */
export interface DaoDelegateScope {
  schemas: string[];
  /** Unix seconds. */
  expiresAt: number;
  maxUses: number;
  canRevoke?: boolean;
  label?: string;
}

/**
 * A proposal that makes `delegate` an Attestra delegate of the DAO within `scope`: once passed, the
 * delegate calls `attest_on_behalf` and the attestation's attester is the DAO. The contract
 * enforces the schemas, the expiry and the use limit; the grant gives no say over the DAO itself.
 */
export function daoDelegateProposal(attestations: string, delegate: string, scope: DaoDelegateScope, description?: string): DaoProposalInput {
  const args = {
    delegate,
    scope: { schemas: scope.schemas.map(normalizeUid), expires_at: scope.expiresAt, max_uses: scope.maxUses, can_revoke: scope.canRevoke ?? false, label: scope.label ?? 'issues on behalf of the DAO' },
  };
  return {
    description: description ?? `Let ${delegate} issue ${scope.schemas.length} schema(s) on behalf of the DAO, at most ${scope.maxUses} times`,
    kind: { FunctionCall: { receiver_id: attestations, actions: [{ method_name: 'add_delegate', args: toBase64Json(args), deposit: '0', gas: (30n * TGAS).toString() }] } },
  };
}

/** A proposal that withdraws a delegate's grant. */
export function daoRemoveDelegateProposal(attestations: string, delegate: string, description?: string): DaoProposalInput {
  return {
    description: description ?? `Withdraw ${delegate}'s grant to issue on behalf of the DAO`,
    kind: { FunctionCall: { receiver_id: attestations, actions: [{ method_name: 'remove_delegate', args: toBase64Json({ delegate }), deposit: '0', gas: (30n * TGAS).toString() }] } },
  };
}

/** An account's signed request for a membership the DAO's delegate issues (NEP-413). */
export interface DaoMembershipRequest {
  message: string;
  /** base64 of 32 bytes */
  nonce: string;
  /** `ed25519:<base58>` */
  public_key: string;
  /** base64 of 64 bytes */
  signature: string;
}

/** The exact text an account signs to ask a DAO for membership; key order is fixed. */
export function daoMembershipMessage(p: { dao: string; account: string; role: string; deadline: number }): string {
  return JSON.stringify({ action: 'dao_membership', dao: p.dao, account: p.account, role: p.role, deadline: p.deadline });
}

/** Signs a membership request with the account's key, for the attestations contract as recipient. */
export async function signDaoMembership(signer: MessageSigner, p: { dao: string; account: string; role: string; deadline?: number }, attestations: string): Promise<DaoMembershipRequest> {
  const message = daoMembershipMessage({ ...p, deadline: p.deadline ?? Math.floor(Date.now() / 1000) + 600 });
  const nonce = randomNonce();
  const signed = await signer.signMessage({ message, recipient: attestations, nonce });
  const raw = signed.signature.includes(':') ? signed.signature.split(':')[1] : signed.signature;
  let sig: Uint8Array;
  try {
    sig = base58Decode(raw);
    if (sig.length !== 64) throw new Error('not base58');
  } catch {
    sig = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  }
  return { message, nonce: bytesToBase64(nonce), public_key: signed.publicKey, signature: bytesToBase64(sig) };
}

/** Checks a membership request: the message, the deadline, the signature and the key's owner. Throws the reason. */
export async function verifyDaoMembershipRequest(
  req: DaoMembershipRequest,
  opts: { attestations: string; hasFullAccessKey: (accountId: string, publicKey: string) => Promise<boolean>; now?: number },
): Promise<{ dao: string; account: string; role: string }> {
  let m: { action?: string; dao?: string; account?: string; role?: string; deadline?: number };
  try {
    m = JSON.parse(req.message);
  } catch {
    throw new Error('the signed message is not a membership request');
  }
  if (m.action !== 'dao_membership' || !m.dao || !m.account || !m.role) throw new Error('the signed message is not a membership request');
  if (m.role.length > 32 || !/^[a-z0-9 _-]+$/.test(m.role)) throw new Error('a role is up to 32 lowercase letters, digits, spaces, - and _');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof m.deadline !== 'number' || m.deadline < now) throw new Error('the signed request has expired');
  if (m.deadline > now + 86_400) throw new Error('the signed request is valid for more than a day');
  if (!req.public_key.startsWith('ed25519:')) throw new Error('the key must be ed25519');
  const key = base58Decode(req.public_key.slice(8));
  const nonce = base64ToBytes(req.nonce);
  const sig = base64ToBytes(req.signature);
  if (key.length !== 32 || nonce.length !== 32 || sig.length !== 64) throw new Error('the request is malformed');
  if (!ed25519.verify(sig, nep413Hash(req.message, nonce, opts.attestations), key)) throw new Error('the signature does not verify');
  const implicit = /^[0-9a-f]{64}$/.test(m.account);
  if (implicit ? bytesToHex(key) !== m.account : !(await opts.hasFullAccessKey(m.account, req.public_key))) {
    throw new Error(`${req.public_key} is not a full-access key of ${m.account}`);
  }
  return { dao: m.dao, account: m.account, role: m.role };
}

/** A proposal that replaces the DAO's policy; only a role allowed `policy:*` can pass it. */
export function daoPolicyProposal(policy: DaoPolicy, description = 'Change the policy'): DaoProposalInput {
  return { description, kind: { ChangePolicy: { policy } } };
}

/** Arguments for the factory's `create`: the DAO's config and policy, base64 JSON. */
export function sputnikCreateArgs(p: { name: string; purpose: string; policy: DaoPolicy; metadata?: string }): { name: string; args: string } {
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(p.name) || p.name.length > 32) throw new Error('a DAO name is lowercase letters, digits, - and _, at most 32 characters');
  return { name: p.name, args: toBase64Json({ config: { name: p.name, purpose: p.purpose, metadata: p.metadata ?? '' }, policy: p.policy }) };
}

/** Attestra events (NEP-297) in a transaction outcome, from every receipt. */
export function attestraEvents(outcome: unknown): Array<{ event: string; data: Array<Record<string, unknown>> }> {
  const o = outcome as { transaction_outcome?: { outcome?: { logs?: string[] } }; receipts_outcome?: Array<{ outcome?: { logs?: string[] } }> } | undefined;
  const logs = [...(o?.transaction_outcome?.outcome?.logs ?? []), ...(o?.receipts_outcome ?? []).flatMap((r) => r.outcome?.logs ?? [])];
  const out: Array<{ event: string; data: Array<Record<string, unknown>> }> = [];
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      const e = JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard?: string; event?: string; data?: Array<Record<string, unknown>> };
      if (e.standard === 'attestra' && e.event) out.push({ event: e.event, data: e.data ?? [] });
    } catch {
      // not an event line
    }
  }
  return out;
}

/** The first receipt failure in a transaction outcome, as text. */
export function receiptFailure(outcome: unknown): string | null {
  const o = outcome as { receipts_outcome?: Array<{ outcome?: { status?: { Failure?: unknown } } }> } | undefined;
  for (const r of o?.receipts_outcome ?? []) {
    const f = r.outcome?.status?.Failure;
    if (f) return JSON.stringify(f);
  }
  return null;
}

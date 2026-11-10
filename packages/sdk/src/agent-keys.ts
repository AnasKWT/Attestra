/**
 * Scoped delegation with a NEAR function-call access key: an account adds a key that an AI agent
 * holds, limited to the attestations contract, a few methods and a gas allowance. The agent then
 * signs as the account itself, but can only attest and revoke, cannot attach a deposit (NEAR
 * refuses deposits from function-call keys) and stops when the allowance is spent.
 */

import { isValidPublicKey } from 'near-kit';

/** What a key allows by default: attest and revoke as the account (revoke now or at a set time). */
export const AGENT_KEY_METHODS = ['attest', 'revoke', 'schedule_revocation'] as const;

/**
 * Every method an agent key may be scoped to: the attest and revoke family. Never storage
 * (withdrawing moves NEAR), delegation, signer keys, authority, multisig or owner methods, since a
 * key that could call those could widen its own power or reach the account's funds.
 */
export const AGENT_KEY_GRANTABLE_METHODS = [...AGENT_KEY_METHODS, 'attest_on_behalf', 'revoke_on_behalf', 'submit_signed'] as const;

/** Default gas allowance of an agent key, in NEAR. */
export const AGENT_KEY_ALLOWANCE_NEAR = '0.25';

/** A function-call key on an account whose receiver is the attestations contract. */
export interface AgentKey {
  publicKey: string;
  receiverId: string;
  methodNames: string[];
  /** Gas allowance left, in yoctoNEAR; null when unlimited. */
  allowance: string | null;
}

/** An error the SDK raises for bad input; `fail` maps it to VALIDATION_ERROR. */
export const invalid = (message: string) => Object.assign(new Error(message), { validation: true });

/** `"0.25"` NEAR to yoctoNEAR; refuses anything that is not a plain decimal with at most 24 places. */
export function nearToYocto(near: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(String(near).trim());
  if (!m) throw invalid(`${near} must be an amount of NEAR such as 0.25`);
  return BigInt(m[1]) * 10n ** 24n + BigInt((m[2] ?? '').padEnd(24, '0'));
}

/** Checks a grant and returns the permission to add; throws a validation error otherwise. */
export function agentKeyGrant(publicKey: string, opts: { methods?: string[]; allowanceNear?: string } = {}): { methodNames: string[]; allowance: bigint } {
  if (!isValidPublicKey(publicKey)) throw invalid(`${publicKey} must be a NEAR public key such as ed25519:...`);
  // An empty method list on NEAR means every method, so it is never passed through.
  const methodNames = [...new Set((opts.methods ?? [...AGENT_KEY_METHODS]).map((m) => m.trim()).filter(Boolean))];
  if (methodNames.length === 0) throw invalid('methods must name at least one method');
  const refused = methodNames.filter((m) => !(AGENT_KEY_GRANTABLE_METHODS as readonly string[]).includes(m));
  if (refused.length) throw invalid(`an agent key does not allow ${refused.join(', ')}; methods must be among ${AGENT_KEY_GRANTABLE_METHODS.join(', ')}`);
  const allowance = nearToYocto(opts.allowanceNear ?? AGENT_KEY_ALLOWANCE_NEAR);
  if (allowance === 0n) throw invalid('the allowance must be more than 0 NEAR');
  return { methodNames, allowance };
}

type Permission = 'FullAccess' | { FunctionCall?: { allowance: string | null; receiver_id: string; method_names: string[] } } | Record<string, unknown>;

/** The function-call part of an access key permission, when it is one. */
export function functionCallOf(permission: Permission) {
  return typeof permission === 'object' && permission && 'FunctionCall' in permission
    ? (permission.FunctionCall as { allowance: string | null; receiver_id: string; method_names: string[] })
    : undefined;
}

/** The keys of a `view_access_key_list` answer that are function-call keys for `receiverId`. */
export function agentKeysFrom(list: { keys?: Array<{ public_key: string; access_key: { permission: Permission } }> }, receiverId: string): AgentKey[] {
  const keys: AgentKey[] = [];
  for (const k of list.keys ?? []) {
    const fc = functionCallOf(k.access_key.permission);
    if (fc && fc.receiver_id === receiverId) keys.push({ publicKey: k.public_key, receiverId, methodNames: fc.method_names, allowance: fc.allowance ?? null });
  }
  return keys;
}

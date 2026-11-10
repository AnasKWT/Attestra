/**
 * Maps contract panics, RPC failures and wallet errors to `AttestraErrorType`, so callers can
 * branch on a small, stable set of categories.
 */

import { AttestraErrorType, type ServiceResponse } from './types';

const RULES: Array<[RegExp, AttestraErrorType]> = [
  [/already exists|already registered|already known|already approved|already used|AddKeyAlreadyExists/i, AttestraErrorType.ALREADY_EXISTS],
  [/already revoked/i, AttestraErrorType.ALREADY_REVOKED],
  [/not found|unknown schema|unknown blob|unknown operation|does not exist|DeleteKeyDoesNotExist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/i, AttestraErrorType.NOT_FOUND],
  [/only the|only members|only governance|not a delegate|not a signer key|invalid signature|outside the delegation|does not allow|reserved account|not allowed|NotEnoughAllowance|AccessKeyNotFound|Unauthorized/i, AttestraErrorType.UNAUTHORIZED],
  [/expired|deadline|no uses left/i, AttestraErrorType.EXPIRED],
  [/storage balance|no storage balance|registration minimum|LackBalanceForState|NotEnoughBalance|insufficient/i, AttestraErrorType.INSUFFICIENT_STORAGE],
  [/resolver refused|rejected|refused/i, AttestraErrorType.RESOLVER_REJECTED],
  [/must be|invalid|expects|too long|too large|too many|empty|unknown type|duplicate|not revocable|between|in the future|is still pending|already pending/i, AttestraErrorType.VALIDATION_ERROR],
  [/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|timeout|429|Too Many Requests|socket/i, AttestraErrorType.NETWORK_ERROR],
];

/** Extracts the most useful message from a near-kit, RPC or wallet error. */
export function errorMessage(error: unknown): string {
  if (error == null) return 'unknown error';
  if (typeof error === 'string') return error;
  const e = error as { panic?: string; message?: string; cause?: unknown; type?: string; kind?: unknown };
  if (typeof e.panic === 'string' && e.panic) return e.panic;
  const msg = e.message ?? String(error);
  const smart = /Smart contract panicked: (.+?)(?:\n|$)/.exec(msg);
  if (smart) return smart[1];
  const guest = /GuestPanic.*?panic_msg: "?(.+?)"?\s*[})]/.exec(msg);
  if (guest) return guest[1];
  return msg;
}

export function classifyError(error: unknown): AttestraErrorType {
  const msg = errorMessage(error);
  for (const [re, type] of RULES) if (re.test(msg)) return type;
  const name = (error as { name?: string })?.name ?? '';
  if (/Network|Timeout/i.test(name)) return AttestraErrorType.NETWORK_ERROR;
  if (/FunctionCall|Transaction/i.test(name)) return AttestraErrorType.TRANSACTION_ERROR;
  return AttestraErrorType.UNKNOWN_ERROR;
}

/** Errors the SDK raises itself carry a flag: `config` (no signer, missing URL) or `validation` (bad input). */
function flaggedType(error: unknown): AttestraErrorType | undefined {
  const e = error as { config?: boolean; validation?: boolean } | null;
  if (e?.config) return AttestraErrorType.CONFIGURATION_ERROR;
  if (e?.validation) return AttestraErrorType.VALIDATION_ERROR;
  return undefined;
}

export function fail<T>(error: unknown, type?: AttestraErrorType): ServiceResponse<T> {
  return { success: false, error: { type: type ?? flaggedType(error) ?? classifyError(error), message: errorMessage(error) } };
}

export function ok<T>(data: T, txHash?: string): ServiceResponse<T> {
  return txHash ? { success: true, data, txHash } : { success: true, data };
}

/** Runs `fn` and wraps the result; never throws. */
export async function attempt<T>(fn: () => Promise<ServiceResponse<T> | T>): Promise<ServiceResponse<T>> {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'success' in (r as object) && typeof (r as ServiceResponse<T>).success === 'boolean') {
      return r as ServiceResponse<T>;
    }
    return ok(r as T);
  } catch (error) {
    return fail<T>(error);
  }
}

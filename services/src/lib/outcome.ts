/** Reads a transaction outcome: its hash and the decoded return value of the last receipt. */

export function txHashOf(outcome: unknown): string {
  const o = outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | undefined;
  return o?.transaction?.hash ?? o?.transaction_outcome?.id ?? '';
}

/** The JSON (or text) a successful transaction returned; throws on a failed one. */
export function successValue(outcome: unknown): unknown {
  const status = (outcome as { status?: { SuccessValue?: string; Failure?: unknown } } | undefined)?.status;
  if (status && typeof status === 'object' && 'Failure' in status && status.Failure) {
    throw Object.assign(new Error(JSON.stringify(status.Failure)), { name: 'TransactionError', txHash: txHashOf(outcome) });
  }
  const v = status?.SuccessValue;
  if (!v) return null;
  const text = Buffer.from(v, 'base64').toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

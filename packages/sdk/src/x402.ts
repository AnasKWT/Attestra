/**
 * x402 on NEAR, `exact` scheme (x402 v2): pay per call with a NEP-141 token.
 *
 * A paid endpoint answers `402 Payment Required` with a `PAYMENT-REQUIRED` header (base64 JSON
 * listing what it accepts). The client signs a NEP-366 delegate action holding one `ft_transfer`
 * of the asked amount to `payTo` (with the 1 yoctoNEAR NEP-141 requires) and repeats the request
 * with that signed action in a `PAYMENT-SIGNATURE` header. The server checks it, serves the
 * response, and its relayer submits the action (paying the gas). The payer needs the token and a
 * full-access key, but no NEAR. The answer carries a `PAYMENT-RESPONSE` header naming the
 * transaction.
 *
 * On testnet the token is Attestra's test token (free from its faucet); on mainnet it is native USDC.
 */

import { Near, decodeSignedDelegateAction } from 'near-kit';

export const X402_VERSION = 2;
export const NEAR_CAIP2 = { testnet: 'near:testnet', mainnet: 'near:mainnet' } as const;
export const X402_HEADERS = {
  required: 'PAYMENT-REQUIRED',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
} as const;

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  /** Atomic units of `asset`. */
  amount: string;
  /** NEP-141 contract. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  description?: string;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: number;
  scheme: 'exact';
  network: string;
  accepted: PaymentRequirements;
  payload: { signedDelegateAction: string };
}

export interface SettlementResponse {
  success: boolean;
  transaction?: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export function encodeHeader(value: unknown): string {
  const json = JSON.stringify(value);
  return typeof Buffer !== 'undefined' ? Buffer.from(json, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(json)));
}

export function decodeHeader<T>(header: string): T {
  const json = typeof Buffer !== 'undefined' ? Buffer.from(header, 'base64').toString('utf8') : decodeURIComponent(escape(atob(header)));
  return JSON.parse(json) as T;
}

/** Signs the payment: one `ft_transfer` as a delegate action, valid for the requirement's timeout. */
export async function createPaymentPayload(near: Near, payer: string, req: PaymentRequirements): Promise<PaymentPayload> {
  const blocks = Math.max(30, Math.ceil(req.maxTimeoutSeconds / 0.6) + 10);
  const { payload } = await near
    .transaction(payer)
    .functionCall(req.asset, 'ft_transfer', { receiver_id: req.payTo, amount: req.amount, memo: 'x402' }, { gas: '30 Tgas', attachedDeposit: '1 yocto' })
    .delegate({ blockHeightOffset: blocks });
  return { x402Version: X402_VERSION, scheme: 'exact', network: req.network, accepted: req, payload: { signedDelegateAction: payload } };
}

/** Server side: checks a payment matches the requirement before serving (the chain does the rest at settlement). */
export function checkPayment(payment: PaymentPayload, req: PaymentRequirements): { ok: boolean; reason?: string; payer?: string } {
  if (payment.x402Version !== X402_VERSION) return { ok: false, reason: 'unsupported x402 version' };
  if (payment.scheme !== 'exact' || payment.network !== req.network) return { ok: false, reason: 'scheme or network mismatch' };
  let signed;
  try {
    signed = decodeSignedDelegateAction(payment.payload.signedDelegateAction);
  } catch {
    return { ok: false, reason: 'unreadable delegate action' };
  }
  const da = (signed as unknown as { signedDelegate?: { delegateAction: DelegateLike } }).signedDelegate?.delegateAction
    ?? (signed as unknown as { delegateAction: DelegateLike }).delegateAction;
  if (!da) return { ok: false, reason: 'no delegate action' };
  if (da.receiverId !== req.asset) return { ok: false, reason: 'pays the wrong token' };
  if (da.actions.length !== 1) return { ok: false, reason: 'exactly one action expected' };
  const call = (da.actions[0] as { functionCall?: FunctionCallLike }).functionCall;
  if (!call || call.methodName !== 'ft_transfer') return { ok: false, reason: 'the action must be ft_transfer' };
  let args: { receiver_id?: string; amount?: string };
  try {
    args = JSON.parse(new TextDecoder().decode(call.args));
  } catch {
    return { ok: false, reason: 'unreadable transfer arguments' };
  }
  if (args.receiver_id !== req.payTo) return { ok: false, reason: 'pays the wrong account' };
  if (BigInt(args.amount ?? '0') < BigInt(req.amount)) return { ok: false, reason: 'amount too low' };
  return { ok: true, payer: da.senderId };
}

interface DelegateLike {
  senderId: string;
  receiverId: string;
  actions: unknown[];
}
interface FunctionCallLike {
  methodName: string;
  args: Uint8Array;
}

export function selectRequirements(required: PaymentRequired, network: 'testnet' | 'mainnet', maxAmount: bigint): PaymentRequirements {
  const match = required.accepts.find((a) => a.scheme === 'exact' && a.network === NEAR_CAIP2[network] && BigInt(a.amount) <= maxAmount);
  if (!match) throw new Error(`no acceptable payment option within ${maxAmount} on ${network}`);
  return match;
}

/**
 * `fetch` that pays x402 challenges automatically (at most `maxAmount` atomic units per call).
 * Returns the response and, when it paid, the settlement.
 */
export async function payingFetch(
  near: Near,
  payer: string,
  network: 'testnet' | 'mainnet',
  url: string,
  init: RequestInit = {},
  maxAmount = 10n ** 24n,
): Promise<{ response: Response; settlement: SettlementResponse | null; paid: PaymentRequirements | null }> {
  const first = await fetch(url, init);
  if (first.status !== 402) return { response: first, settlement: null, paid: null };
  const header = first.headers.get(X402_HEADERS.required);
  const required = header ? decodeHeader<PaymentRequired>(header) : ((await first.json()) as PaymentRequired);
  const req = selectRequirements(required, network, maxAmount);
  const payment = await createPaymentPayload(near, payer, req);
  const headers = new Headers(init.headers);
  headers.set(X402_HEADERS.signature, encodeHeader(payment));
  const response = await fetch(url, { ...init, headers });
  const settled = response.headers.get(X402_HEADERS.response);
  return { response, settlement: settled ? decodeHeader<SettlementResponse>(settled) : null, paid: req };
}

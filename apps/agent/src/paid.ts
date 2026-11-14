/**
 * Paid verification over x402 on NEAR. Without payment the endpoint answers 402 with the price;
 * with a `PAYMENT-SIGNATURE` header it checks the signed delegate action (one ft_transfer of at least
 * the price to the agent), settles it on chain from the agent's account, and only then answers.
 */

import { decodeSignedDelegateAction, type Near } from 'near-kit';
import { x402, type NetworkConfig } from 'attestra';

export interface PaidDeps {
  near: Near | null;
  agentAccount: string;
  net: NetworkConfig;
  /** The agent's public base URL (AGENT_PUBLIC_URL); the challenge names the resource under it, not under the proxy's internal address. */
  publicUrl?: string;
}

export function requirements(deps: PaidDeps, amount: string, description: string): x402.PaymentRequirements {
  return {
    scheme: 'exact',
    network: x402.NEAR_CAIP2[deps.net.network],
    amount,
    asset: deps.net.paymentToken,
    payTo: deps.agentAccount,
    maxTimeoutSeconds: 120,
    description,
    extra: { decimals: deps.net.paymentTokenDecimals, symbol: deps.net.network === 'mainnet' ? 'USDC' : 'tATT' },
  };
}

/** The URL a client should call: the request's path and query under the public base URL when one is set. */
export function publicResource(requestUrl: string, publicUrl?: string): string {
  if (!publicUrl) return requestUrl;
  const u = new URL(requestUrl);
  return `${publicUrl.replace(/\/+$/, '')}${u.pathname}${u.search}`;
}

/** Handles one paid request: returns a 402 challenge, a 402 refusal, or runs `serve` after settlement. */
export async function paid(req: Request, deps: PaidDeps, reqs: x402.PaymentRequirements, serve: () => Promise<unknown>): Promise<Response> {
  const header = req.headers.get(x402.X402_HEADERS.signature);
  const challenge: x402.PaymentRequired = { x402Version: x402.X402_VERSION, resource: { url: publicResource(req.url, deps.publicUrl), description: reqs.description, mimeType: 'application/json' }, accepts: [reqs] };
  if (!header) {
    return Response.json({ ...challenge, error: 'payment required' }, { status: 402, headers: { [x402.X402_HEADERS.required]: x402.encodeHeader(challenge) } });
  }
  let payment: x402.PaymentPayload;
  try {
    payment = x402.decodeHeader<x402.PaymentPayload>(header);
  } catch {
    return Response.json({ ...challenge, error: 'unreadable payment header' }, { status: 402 });
  }
  const check = x402.checkPayment(payment, reqs);
  if (!check.ok) return Response.json({ ...challenge, error: check.reason }, { status: 402, headers: { [x402.X402_HEADERS.required]: x402.encodeHeader(challenge) } });
  if (!deps.near) return Response.json({ error: 'the agent has no key to settle payments' }, { status: 503 });

  let txHash: string;
  try {
    const signed = decodeSignedDelegateAction(payment.payload.signedDelegateAction);
    const out = await deps.near.transaction(deps.agentAccount).signedDelegateAction(signed).send();
    txHash = (out as { transaction: { hash: string } }).transaction.hash;
    const failure = JSON.stringify((out as { receipts_outcome?: unknown[] }).receipts_outcome ?? []).includes('"Failure"');
    if (failure) throw new Error('the transfer failed on chain');
  } catch (e) {
    return Response.json({ ...challenge, error: `settlement failed: ${(e as Error).message}` }, { status: 402 });
  }
  const settlement: x402.SettlementResponse = { success: true, transaction: txHash, network: reqs.network, payer: check.payer };
  const result = await serve();
  return Response.json(result, { headers: { [x402.X402_HEADERS.response]: x402.encodeHeader(settlement) } });
}

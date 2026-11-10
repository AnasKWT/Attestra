/** Reads the model signers a verdicts contract trusts (`get_config().model_signers`) over NEAR RPC. */

import type { TrustedSigner } from './verify.js';

export async function readTrustedSigners(rpcUrl: string, contract: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<TrustedSigner[]> {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'nearai-verify',
      method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: 'get_config', args_base64: Buffer.from('{}').toString('base64') },
    }),
  });
  if (!res.ok) throw new Error(`${rpcUrl} answered ${res.status}`);
  const body = (await res.json()) as { result?: { result?: number[] }; error?: { cause?: { name?: string }; message?: string } };
  if (!body.result?.result) throw new Error(`get_config on ${contract} failed: ${body.error?.cause?.name ?? body.error?.message ?? 'no result'}`);
  const config = JSON.parse(Buffer.from(body.result.result).toString('utf8')) as { model_signers?: Array<{ model?: unknown; algo?: unknown; key?: unknown }> };
  return (config.model_signers ?? []).map((s) => {
    if (typeof s.model !== 'string' || typeof s.key !== 'string' || (s.algo !== 'ed25519' && s.algo !== 'ecdsa')) {
      throw new Error(`${contract} lists a malformed model signer: ${JSON.stringify(s)}`);
    }
    return { model: s.model, algo: s.algo, key: s.key };
  });
}

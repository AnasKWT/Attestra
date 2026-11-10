/** Argument parsing and output for the CLI, kept apart from the network so it is unit tested. */

import { parseArgs } from 'node:util';
import type { SigningAlgo } from '@nearai/inference-sdk/node';
import type { ModelReport } from './verify.js';

export const DEFAULT_CONTRACT = 'verdicts.attestra.testnet';
export const DEFAULT_RPC = 'https://rpc.testnet.fastnear.com';

export const USAGE = `attestra-nearai-verify: checks NEAR AI Cloud evidence with @nearai/inference-sdk (Node >= 24.22.1, NEARAI_API_KEY)

  node dist/index.js [options]

  --contract <account>   verdicts contract whose model_signers to check (default ${DEFAULT_CONTRACT})
  --rpc <url>            NEAR RPC for the contract (default ${DEFAULT_RPC})
  --model <id>           only this model (with --no-contract: attest it without a trusted key)
  --expect-key <hex>     trust this key instead of reading the contract (needs --model)
  --algo <ed25519|ecdsa> signing algorithm when no contract names it (default ed25519)
  --no-contract          do not read a contract
  --chat-id <id>         also verify this chat's signature, with:
  --request-file <path>    the exact request body bytes sent
  --response-file <path>   the exact response body bytes received
  --probe                send one tiny completion and verify its signature (costs a few tokens)
  --gpu <required|if-present>  NVIDIA GPU evidence policy (default required)
  --base-url <url>       NEAR AI Cloud API base (default the SDK's, https://cloud-api.near.ai/v1)
  --json                 print one JSON object
  -h, --help

Exit status: 0 when every check passed, 1 when one failed, 2 on a usage error.`;

/** The SDK's engines field: Node >= 24.22.1. */
export function nodeSupported(version: string): boolean {
  const [a = 0, b = 0, c = 0] = version.replace(/^v/, '').split('.').map(Number);
  return a !== 24 ? a > 24 : b !== 22 ? b > 22 : c >= 1;
}

export interface Options {
  contract?: string;
  rpc: string;
  model?: string;
  expectKey?: string;
  algo: SigningAlgo;
  chat?: { id: string; requestFile: string; responseFile: string };
  probe: boolean;
  gpu: 'required' | 'if-present';
  baseUrl?: string;
  json: boolean;
  help: boolean;
}

export class UsageError extends Error {}

export function parseCli(argv: string[]): Options {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        contract: { type: 'string' },
        rpc: { type: 'string' },
        model: { type: 'string' },
        'expect-key': { type: 'string' },
        algo: { type: 'string' },
        'no-contract': { type: 'boolean' },
        'chat-id': { type: 'string' },
        'request-file': { type: 'string' },
        'response-file': { type: 'string' },
        probe: { type: 'boolean' },
        gpu: { type: 'string' },
        'base-url': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const algo = values.algo ?? 'ed25519';
  if (algo !== 'ed25519' && algo !== 'ecdsa') throw new UsageError(`--algo must be ed25519 or ecdsa, not ${algo}`);
  const gpu = values.gpu ?? 'required';
  if (gpu !== 'required' && gpu !== 'if-present') throw new UsageError(`--gpu must be required or if-present, not ${gpu}`);
  const expectKey = values['expect-key'];
  if (expectKey !== undefined && !/^(0x)?[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/.test(expectKey)) throw new UsageError('--expect-key must be a 32-byte ed25519 key or a 20-byte ecdsa address in hex');
  if (expectKey && !values.model) throw new UsageError('--expect-key needs --model');
  if (values['no-contract'] && values.contract) throw new UsageError('--contract and --no-contract exclude each other');
  if (values['no-contract'] && !values.model) throw new UsageError('--no-contract needs --model');
  const chatParts = [values['chat-id'], values['request-file'], values['response-file']];
  if (chatParts.some(Boolean) && !chatParts.every(Boolean)) {
    throw new UsageError('--chat-id needs --request-file and --response-file: the SDK verifies a signature against the exact request and response bytes, not their hashes');
  }
  return {
    contract: values['no-contract'] || expectKey ? undefined : (values.contract ?? DEFAULT_CONTRACT),
    rpc: values.rpc ?? DEFAULT_RPC,
    model: values.model,
    expectKey,
    algo,
    chat: values['chat-id'] ? { id: values['chat-id'], requestFile: values['request-file']!, responseFile: values['response-file']! } : undefined,
    probe: Boolean(values.probe),
    gpu,
    baseUrl: values['base-url'],
    json: Boolean(values.json),
    help: Boolean(values.help),
  };
}

export interface Summary {
  ok: boolean;
  sdk?: string;
  contract?: string;
  reports: ModelReport[];
  error?: { code?: string; message: string };
}

export function render(s: Summary): string {
  const out: string[] = [];
  const mark = (ok: boolean) => (ok ? 'VERIFIED' : 'FAILED');
  const why = (e: { code?: string; message: string }) => (e.code && !e.message.includes(e.code) ? `${e.message} (${e.code})` : e.message);
  out.push(`NEAR AI Cloud evidence checked with @nearai/inference-sdk${s.sdk ? ` ${s.sdk}` : ''}${s.contract ? ` against ${s.contract}` : ''}`);
  if (s.error) out.push(`FAILED ${why(s.error)}`);
  for (const r of s.reports) {
    out.push('', `${mark(r.ok)} ${r.model}`);
    for (const c of r.checks) out.push(`  - ${c}`);
    if (r.response) {
      const p = r.response;
      out.push(`  - Response ${p.chatId || '(none)'}: ${p.ok ? `${p.kind} signature verified over the exact bytes, signer ${p.signer}${p.trusted ? ' (the trusted key)' : ''}` : 'FAILED'}`);
      if (p.error) out.push(`    ${why(p.error)}`);
    }
    if (r.error) out.push(`  ${why(r.error)}`);
  }
  out.push('', s.ok ? 'All checks passed' : 'A check failed');
  return out.join('\n');
}

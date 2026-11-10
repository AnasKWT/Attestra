/**
 * Agent tools over AttestraClient, defined once as plain JSON-schema tools. The MCP server
 * (@attestra/mcp), the Attestra agent and `@attestra/sdk/ai` (LangChain) all wrap these, and any
 * OpenAI-compatible agent can use `openAITools()` directly (for example on NEAR AI Cloud).
 */

import { AGENT_KEY_ALLOWANCE_NEAR, AGENT_KEY_GRANTABLE_METHODS, AGENT_KEY_METHODS, invalid, nearToYocto } from './agent-keys';
import type { AttestraClient } from './client';
import { SchemaEncoder } from './encoder';
import { fail } from './errors';
import { KNOWN_SCHEMAS, knownSchemas } from './schemas';
import type { Network } from './types';
import { computeSchemaUid } from './uid';
import type { EvmLog } from './verdicts';

/**
 * Per-call spend limits for write tools, so an agent cannot be talked into a large deposit, key
 * allowance or payment. `runTool` fills what is not given from `defaultToolLimits`.
 */
export interface ToolLimits {
  /** Largest gas allowance `grant_agent_key` may give a key, in NEAR. */
  maxKeyAllowanceNear: string;
  /** Largest deposit `link_wallet` and `attest_foreign_event` may attach, in NEAR. */
  maxDepositNear: string;
  /** Largest x402 payment `paid_verify` may make, in the payment token's smallest unit. */
  maxPayment: string;
}

/** 1 NEAR of key allowance, 0.25 NEAR of deposit, and 5 test tokens (testnet) or 0.05 USDC (mainnet) per payment. */
export function defaultToolLimits(network: Network): ToolLimits {
  return { maxKeyAllowanceNear: '1', maxDepositNear: '0.25', maxPayment: network === 'mainnet' ? '50000' : '5000000000000000000' };
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** Writes send a transaction (or start a paid or private check). */
  write: boolean;
  run: (client: AttestraClient, args: Record<string, unknown>, limits: ToolLimits) => Promise<unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const uid = (description: string) => ({ type: 'string', description, pattern: '^(0x)?[0-9a-fA-F]{64}$' });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });
const oneOf = (description: string, values: readonly string[]) => ({ type: 'string', description, enum: [...values] });
const list = (description: string, items: Record<string, unknown> = { type: 'string' }) => ({ type: 'array', description, items });
const WALLET_CHAINS = ['eip155', 'solana'] as const;

function unwrap<T>(r: { success: boolean; data?: T; error?: { type: string; message: string }; txHash?: string }) {
  if (!r.success) return { ok: false, error: r.error };
  return r.txHash ? { ok: true, data: r.data, tx_hash: r.txHash } : { ok: true, data: r.data };
}

async function decodeFor(client: AttestraClient, schemaUid: string, data: string): Promise<Record<string, unknown> | null> {
  const s = await client.getSchema(schemaUid);
  if (!s.success || !s.data) return null;
  try {
    return new SchemaEncoder(s.data.definition).decode(data);
  } catch {
    return null;
  }
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'get_schema',
    description: 'Look up a schema by UID: its definition (field types), authority, resolver and whether it is revocable.',
    parameters: { type: 'object', properties: { uid: uid('Schema UID, 64 hex characters') }, required: ['uid'] },
    write: false,
    run: async (c, a) => unwrap(await c.getSchema(String(a.uid))),
  },
  {
    name: 'list_schemas',
    description: 'List registered schemas, optionally only those of one authority (NEAR account).',
    parameters: { type: 'object', properties: { authority: str('Authority account id'), limit: int('Max results, default 20') } },
    write: false,
    run: async (c, a) => unwrap(await c.listSchemas({ authority: a.authority as string | undefined, limit: (a.limit as number) ?? 20 })),
  },
  {
    name: 'well_known_schemas',
    description: 'The schemas every Attestra deployment registers (agent identity, agent review, private AI check, cross-chain event, wallet link, membership) with their UIDs.',
    parameters: { type: 'object', properties: {} },
    write: false,
    run: async () => ({ ok: true, data: knownSchemas() }),
  },
  {
    name: 'get_attestation',
    description: 'Look up an attestation by UID, with its status (active, pending, revoking, revoked, expired) and its data decoded with its schema.',
    parameters: { type: 'object', properties: { uid: uid('Attestation UID') }, required: ['uid'] },
    write: false,
    run: async (c, a) => {
      const r = await c.getAttestation(String(a.uid));
      if (!r.success || !r.data) return unwrap(r);
      return { ok: true, data: { ...r.data, decoded: await decodeFor(c, r.data.schema_uid, r.data.data) } };
    },
  },
  {
    name: 'verify_attestation',
    description: 'Check whether an attestation is valid right now (exists, active, not revoked, not expired).',
    parameters: { type: 'object', properties: { uid: uid('Attestation UID') }, required: ['uid'] },
    write: false,
    run: async (c, a) => {
      const r = await c.getAttestation(String(a.uid));
      if (!r.success || !r.data) return unwrap(r);
      return { ok: true, data: { valid: r.data.status === 'active', status: r.data.status, attester: r.data.attester, subject: r.data.subject } };
    },
  },
  {
    name: 'list_attestations',
    description: 'List attestations filtered by schema UID, attester or subject (needs the indexer).',
    parameters: {
      type: 'object',
      properties: { schema_uid: uid('Schema UID'), attester: str('Attester account'), subject: str('Subject (NEAR account or CAIP-10)'), limit: int('Max results') },
    },
    write: false,
    run: async (c, a) =>
      unwrap(await c.listAttestations({ schemaUid: a.schema_uid as string | undefined, attester: a.attester as string | undefined, subject: a.subject as string | undefined, limit: (a.limit as number) ?? 20 })),
  },
  {
    name: 'get_authority',
    description: 'Look up an authority (issuer): metadata, kind, whether governance verified it, and its staking tier.',
    parameters: { type: 'object', properties: { account_id: str('NEAR account id') }, required: ['account_id'] },
    write: false,
    run: async (c, a) => unwrap(await c.getAuthority(String(a.account_id))),
  },
  {
    name: 'get_delegates',
    description: 'List the delegates (employees, agents, systems) an authority lets attest for it, with scope, expiry and uses.',
    parameters: { type: 'object', properties: { authority: str('Authority account id') }, required: ['authority'] },
    write: false,
    run: async (c, a) => unwrap(await c.getDelegates(String(a.authority))),
  },
  {
    name: 'get_agent_reputation',
    description: "Know Your Agent: an AI agent's identity (owner, model, capabilities, endpoint), reviews with the average score, and the delegations it holds.",
    parameters: { type: 'object', properties: { agent: str('Agent account id') }, required: ['agent'] },
    write: false,
    run: async (c, a) => unwrap(await c.getAgentProfile(String(a.agent))),
  },
  {
    name: 'prove_attestation',
    description: 'Prove with a NEAR light client proof that the event creating an attestation is in a final block (checked locally: validator approvals and merkle paths).',
    parameters: { type: 'object', properties: { uid: uid('Attestation UID') }, required: ['uid'] },
    write: false,
    run: async (c, a) => unwrap(await c.proveAttestation(String(a.uid))),
  },
  {
    name: 'linked_account',
    description: 'Which NEAR account a wallet on another chain is linked to (a link proven by that wallet signing on chain), or null.',
    parameters: { type: 'object', properties: { caip10: str('CAIP-10 wallet id, e.g. eip155:1:0xabc... or solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:<address>') }, required: ['caip10'] },
    write: false,
    run: async (c, a) => unwrap(await c.linkedAccount(String(a.caip10))),
  },
  {
    name: 'wallet_link_message',
    description: 'The exact text a wallet on another chain signs (personal_sign for eip155, an ed25519 message signature for solana) to link itself to a NEAR account with link_wallet.',
    parameters: {
      type: 'object',
      properties: { account_id: str('NEAR account the wallet links to'), chain: oneOf('Wallet chain', WALLET_CHAINS), address: str('Wallet address (0x... or base58)') },
      required: ['account_id', 'chain', 'address'],
    },
    write: false,
    run: async (c, a) => unwrap(await c.linkWalletMessage(String(a.account_id), a.chain as 'eip155' | 'solana', String(a.address))),
  },
  {
    name: 'list_agent_keys',
    description: "The NEAR function-call access keys an account gave AI agents for the attestations contract: each key's allowed methods and gas allowance left (yoctoNEAR).",
    parameters: { type: 'object', properties: { account_id: str('NEAR account id') }, required: ['account_id'] },
    write: false,
    run: async (c, a) => unwrap(await c.agentKeys(String(a.account_id))),
  },
  {
    name: 'decode_data',
    description: 'Decode base64 attestation data with a schema definition.',
    parameters: { type: 'object', properties: { definition: str('Schema definition, e.g. "string name, u8 level"'), data: str('Base64 data') }, required: ['definition', 'data'] },
    write: false,
    run: async (_c, a) => ({ ok: true, data: new SchemaEncoder(String(a.definition)).decode(String(a.data)) }),
  },
  {
    name: 'compute_schema_uid',
    description: 'Compute the deterministic UID a schema would get, without registering it.',
    parameters: {
      type: 'object',
      properties: { definition: str('Schema definition'), resolver: str('Resolver account, optional'), revocable: bool('Whether attestations can be revoked') },
      required: ['definition', 'revocable'],
    },
    write: false,
    run: async (_c, a) => ({ ok: true, data: { uid: computeSchemaUid(String(a.definition), (a.resolver as string) || null, Boolean(a.revocable)) } }),
  },
  {
    name: 'register_schema',
    description: 'Register a schema. Definition is comma-separated "type name" fields; types: bool, u8..u128, i8..i128, string, account_id, bytes, bytes32, and T[] lists.',
    parameters: {
      type: 'object',
      properties: { definition: str('Schema definition'), revocable: bool('Whether attestations can be revoked'), resolver: str('Optional resolver account') },
      required: ['definition', 'revocable'],
    },
    write: true,
    run: async (c, a) => unwrap(await c.registerSchema({ definition: String(a.definition), revocable: Boolean(a.revocable), resolver: (a.resolver as string) || null })),
  },
  {
    name: 'create_attestation',
    description: 'Attest a claim about a subject under a schema. Give the field values as an object; they are encoded with the schema.',
    parameters: {
      type: 'object',
      properties: {
        schema_uid: uid('Schema UID'),
        subject: str('Subject: a NEAR account or a CAIP-10 id such as eip155:1:0x...'),
        values: { type: 'object', description: 'Field values by name', additionalProperties: true },
        expiration_time: int('Unix seconds, optional'),
      },
      required: ['schema_uid', 'subject', 'values'],
    },
    write: true,
    run: async (c, a) => {
      const s = await c.getSchema(String(a.schema_uid));
      if (!s.success || !s.data) return unwrap(s);
      const data = new SchemaEncoder(s.data.definition).encode(a.values as Record<string, unknown>);
      return unwrap(await c.createAttestation({ schemaUid: String(a.schema_uid), subject: String(a.subject), data, expirationTime: a.expiration_time as number | undefined }));
    },
  },
  {
    name: 'revoke_attestation',
    description: 'Revoke an attestation you issued (its schema must be revocable).',
    parameters: { type: 'object', properties: { uid: uid('Attestation UID') }, required: ['uid'] },
    write: true,
    run: async (c, a) => unwrap(await c.revokeAttestation(String(a.uid))),
  },
  {
    name: 'rate_agent',
    description: 'Leave a 1 to 5 review of an AI agent you hired (an attestation under the agent review schema).',
    parameters: {
      type: 'object',
      properties: { agent: str('Agent account id'), score: int('1 to 5'), comment: str('Short comment'), job_ref: str('What the job was') },
      required: ['agent', 'score'],
    },
    write: true,
    run: async (c, a) => unwrap(await c.rateAgent({ agent: String(a.agent), score: Number(a.score), comment: a.comment as string, jobRef: a.job_ref as string })),
  },
  {
    name: 'request_private_check',
    description:
      'Check a private fact without revealing it: evidence is encrypted to a NEAR AI Cloud verifiable model, an enclave checks it against a rule (age_over_18, income_at_least, github_contributor) and a passing check becomes an attestation that stores only the evidence hash.',
    parameters: {
      type: 'object',
      properties: { rule_id: str('Rule id'), subject: str('Who the fact is about'), evidence: str('The private evidence text'), github: str('GitHub login, for github_contributor') },
      required: ['rule_id', 'subject'],
    },
    write: true,
    run: async (c, a) =>
      unwrap(await c.requestPrivateCheck({ ruleId: String(a.rule_id), subject: String(a.subject), evidence: String(a.evidence ?? ''), github: a.github as string | undefined })),
  },
  {
    name: 'attest_foreign_event',
    description:
      'Attest an event on another chain without an oracle: the NEAR MPC network (Chain Signatures) verifies an EVM transaction log and the verdicts contract attests it. Takes a minute or two.',
    parameters: {
      type: 'object',
      properties: {
        chain: str('EVM chain: base, arbitrum, polygon, bnb, avalanche (testnets on testnet), plus ethereum on mainnet'),
        tx_id: str('Transaction hash (0x...)'),
        log_index: int('Index of the log in the transaction receipt'),
        log: { type: 'object', description: "The expected log in the contract's EvmLog shape; read from the chain's public RPC when omitted", additionalProperties: true },
        subject: str('Subject of the attestation, optional (CAIP-10 or NEAR account)'),
      },
      required: ['chain', 'tx_id', 'log_index'],
    },
    write: true,
    run: async (c, a, limits) =>
      unwrap(
        await c.attestForeignEvent(
          { chain: String(a.chain), txId: String(a.tx_id), logIndex: Number(a.log_index), log: a.log as EvmLog | undefined, subject: a.subject as string | undefined },
          { maxDeposit: nearToYocto(limits.maxDepositNear) },
        ),
      ),
  },
  {
    name: 'link_wallet',
    description: 'Link a wallet on another chain to the signer, proven by the wallet signing the text from wallet_link_message; attests it under the wallet link schema.',
    parameters: {
      type: 'object',
      properties: { chain: oneOf('Wallet chain', WALLET_CHAINS), address: str('Wallet address'), signature: str('The wallet signature over the link message (0x... hex for eip155, base58 for solana)') },
      required: ['chain', 'address', 'signature'],
    },
    write: true,
    run: async (c, a, limits) =>
      unwrap(await c.linkWallet(a.chain as 'eip155' | 'solana', String(a.address), String(a.signature), { maxDeposit: nearToYocto(limits.maxDepositNear) })),
  },
  {
    name: 'register_agent',
    description: "Know Your Agent: register an AI agent you own (an identity attestation about the agent account with its name, model, capabilities and endpoint; you are the owner).",
    parameters: {
      type: 'object',
      properties: {
        agent: str('Agent account id'),
        name: str('Agent name'),
        model: str('Model id, e.g. a NEAR AI Cloud verifiable model'),
        capabilities: list('What the agent does, e.g. ["verify", "attest"]'),
        endpoint: str('Agent URL, optional'),
        description: str('Short description, optional'),
      },
      required: ['agent', 'name', 'model'],
    },
    write: true,
    run: async (c, a) =>
      unwrap(
        await c.registerAgent({
          agent: String(a.agent),
          name: String(a.name),
          model: String(a.model),
          capabilities: Array.isArray(a.capabilities) ? a.capabilities.map(String) : [],
          endpoint: String(a.endpoint ?? ''),
          description: a.description as string | undefined,
        }),
      ),
  },
  {
    name: 'delegate_to_agent',
    description:
      'Let an AI agent attest for you on the attestations contract (a revocable on-chain delegation). Give expires_at or max_uses: an unbounded delegation is refused here. Optionally limit it to some schemas and allow revoking.',
    parameters: {
      type: 'object',
      properties: {
        agent: str('Agent account id'),
        schemas: list('Schema UIDs it may use; omit for any', uid('Schema UID')),
        expires_at: int('Unix seconds when the delegation ends'),
        max_uses: int('Most attestations it may make'),
        can_revoke: bool('Whether it may also revoke attestations it made for you'),
      },
      required: ['agent'],
    },
    write: true,
    run: async (c, a) => {
      if (a.expires_at === undefined && a.max_uses === undefined) throw invalid('give expires_at or max_uses: an unbounded delegation is not granted by a tool');
      return unwrap(
        await c.delegateToAgent(String(a.agent), {
          schemas: Array.isArray(a.schemas) ? a.schemas.map(String) : undefined,
          expiresAt: a.expires_at as number | undefined,
          maxUses: a.max_uses as number | undefined,
          canRevoke: a.can_revoke as boolean | undefined,
        }),
      );
    },
  },
  {
    name: 'grant_agent_key',
    description: `Scoped delegation with a NEAR function-call access key: add a key the agent holds to your account, usable only on the attestations contract, only for some methods (default ${AGENT_KEY_METHODS.join(', ')}) and only up to a gas allowance (default ${AGENT_KEY_ALLOWANCE_NEAR} NEAR). The key cannot move NEAR or attach deposits.`,
    parameters: {
      type: 'object',
      properties: {
        public_key: str("The agent's public key, ed25519:..."),
        methods: list('Methods the key may call; omit for the default', oneOf('Method', AGENT_KEY_GRANTABLE_METHODS)),
        allowance_near: str(`Gas allowance in NEAR, default ${AGENT_KEY_ALLOWANCE_NEAR}; capped by the server`),
      },
      required: ['public_key'],
    },
    write: true,
    run: async (c, a, limits) => {
      const allowance = String(a.allowance_near ?? AGENT_KEY_ALLOWANCE_NEAR);
      if (nearToYocto(allowance) > nearToYocto(limits.maxKeyAllowanceNear)) throw invalid(`allowance_near ${allowance} is above the limit of ${limits.maxKeyAllowanceNear} NEAR`);
      return unwrap(await c.grantAgentKey(String(a.public_key), { methods: Array.isArray(a.methods) ? a.methods.map(String) : undefined, allowanceNear: allowance }));
    },
  },
  {
    name: 'paid_verify',
    description:
      'Paid verification through the Attestra agent over x402: pays per call with a NEP-141 token (the test token on testnet) and returns the verified claim (attestation status and light client proof) or agent check (identity, delegations, reputation) with the settlement.',
    parameters: {
      type: 'object',
      properties: {
        kind: oneOf('claim verifies an attestation; agent checks an AI agent', ['claim', 'agent']),
        target: str('Attestation UID for claim, agent account id for agent'),
        max_amount: str("Most to pay, in the payment token's smallest unit; capped by the server"),
      },
      required: ['kind', 'target'],
    },
    write: true,
    run: async (c, a, limits) => {
      const cap = BigInt(limits.maxPayment);
      if (a.max_amount !== undefined && !/^\d+$/.test(String(a.max_amount))) throw invalid('max_amount must be a whole number of the smallest unit');
      const max = a.max_amount === undefined ? cap : BigInt(String(a.max_amount));
      if (max > cap) throw invalid(`max_amount ${max} is above the limit of ${cap}`);
      const kind = a.kind === 'agent' ? 'agent' : a.kind === 'claim' ? 'claim' : undefined;
      if (!kind) throw invalid('kind must be claim or agent');
      return unwrap(await c.paidVerify(kind, String(a.target), max));
    },
  },
];

export const READ_TOOLS = TOOLS.filter((t) => !t.write).map((t) => t.name);
export const WRITE_TOOLS = TOOLS.filter((t) => t.write).map((t) => t.name);

/** Tools in the OpenAI function-calling format (works with NEAR AI Cloud's OpenAI-compatible API). */
export function openAITools(opts: { includeWrites?: boolean } = {}) {
  return TOOLS.filter((t) => opts.includeWrites || !t.write).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Runs one tool by name; never throws (errors come back as `{ ok: false, error }`). `limits`
 * overrides the spend limits of write tools (the rest come from `defaultToolLimits`).
 */
export async function runTool(
  client: AttestraClient,
  name: string,
  args: Record<string, unknown>,
  opts: { allowWrites?: boolean; limits?: Partial<ToolLimits> } = {},
) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: { type: 'NOT_FOUND', message: `unknown tool ${name}` } };
  if (tool.write && !opts.allowWrites) return { ok: false, error: { type: 'UNAUTHORIZED', message: `${name} writes on chain and is not enabled here` } };
  const given = Object.fromEntries(Object.entries(opts.limits ?? {}).filter(([, v]) => v !== undefined && v !== ''));
  const limits: ToolLimits = { ...defaultToolLimits(client.network), ...given };
  try {
    return await tool.run(client, args ?? {}, limits);
  } catch (e) {
    return unwrap(fail(e));
  }
}

export { KNOWN_SCHEMAS };

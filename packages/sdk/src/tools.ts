/**
 * Agent tools over AttestraClient, defined once as plain JSON-schema tools. The MCP server
 * (@attestra/mcp), the Attestra agent and `@attestra/sdk/ai` (LangChain) all wrap these, and any
 * OpenAI-compatible agent can use `openAITools()` directly (for example on NEAR AI Cloud).
 */

import type { AttestraClient } from './client';
import { SchemaEncoder } from './encoder';
import { KNOWN_SCHEMAS, knownSchemas } from './schemas';
import { computeSchemaUid } from './uid';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** Writes send a transaction (or start a paid or private check). */
  write: boolean;
  run: (client: AttestraClient, args: Record<string, unknown>) => Promise<unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const uid = (description: string) => ({ type: 'string', description, pattern: '^(0x)?[0-9a-fA-F]{64}$' });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });

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

/** Runs one tool by name; never throws (errors come back as `{ ok: false, error }`). */
export async function runTool(client: AttestraClient, name: string, args: Record<string, unknown>, opts: { allowWrites?: boolean } = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: { type: 'NOT_FOUND', message: `unknown tool ${name}` } };
  if (tool.write && !opts.allowWrites) return { ok: false, error: { type: 'UNAUTHORIZED', message: `${name} writes on chain and is not enabled here` } };
  try {
    return await tool.run(client, args ?? {});
  } catch (e) {
    return { ok: false, error: { type: 'UNKNOWN_ERROR', message: (e as Error).message } };
  }
}

export { KNOWN_SCHEMAS };

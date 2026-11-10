import { KNOWN_SCHEMAS, TOOLS, knownSchemaUid } from '@attestra/sdk';
import { CONTRACTS, NET, NETWORK, REPO_URL, SITE_URL } from '@/lib/config';

export const dynamic = 'force-static';

export function GET() {
  const site = SITE_URL || '';
  const body = `# Attestra

> The trust layer for NEAR: a schema-based attestation protocol for issuing, managing and verifying claims about people, wallets on any chain, and AI agents. Private facts are checked by a NEAR AI Cloud verifiable model in a TEE and signed by a checker (an OutLayer TEE component, or a local key while the deployment bootstraps), facts about EVM chains and Solana are verified by NEAR's MPC network without an oracle, agents get identity, delegation, scoped function-call keys and reputation, and any event can be proven final with a light client proof.

Network: NEAR ${NETWORK}. Contracts (Rust, reproducible builds):
- schemas: ${CONTRACTS.schemas}
- attestations: ${CONTRACTS.attestations}
- verdicts (AI-checked facts, EVM and Solana facts, wallet links): ${CONTRACTS.verdicts}
- credentials (NEP-171, non-transferable): ${CONTRACTS.credentials}
- staking (NEP-141 tiers): ${CONTRACTS.staking}
- resolvers: ${Object.values(CONTRACTS.resolvers).join(', ')}
- MPC signer used for cross-chain facts: ${NET.mpc}

## Concepts
- Schema: comma-separated "type name" fields (bool, u8..u128, i8..i128, string, account_id, bytes, bytes32, T[]). UID = sha256(borsh(("attestra:schema:v1", definition, resolver, revocable))).
- Attestation: attester, subject (NEAR account or CAIP-10), Borsh data, expiration, revocation, nonce. UID = sha256(borsh(("attestra:attestation:v1", schema_uid, subject, attester, data, nonce))).
- Status: pending, active, revoking, revoked, expired (expiry and scheduled revocation computed on read).
- Resolvers approve or refuse asynchronously; a refusal rolls the attestation back with a storage refund.

## Agent access
- MCP (Streamable HTTP, read tools): ${site}/mcp
- MCP (stdio, read and capped testnet write tools): npx -y @attestra/mcp once published; until then node packages/mcp/dist/cli.js from a clone
- Tools: ${TOOLS.map((t) => t.name).join(', ')}
- Agent skill: skills/attestra/SKILL.md in the repository${REPO_URL && REPO_URL !== '[placeholder]' ? ` (${REPO_URL})` : ''}

## SDK (TypeScript, @attestra/sdk)
- new AttestraClient({ network: 'testnet', accountId?, privateKey?, indexerUrl? })
- registerSchema, getSchema, createAttestation, getAttestation, isValid, revokeAttestation
- addDelegate, attestOnBehalf, signDelegatedAttestation (NEP-413), relaySigned
- mintCredential, scheduleRevocation, createMultisigAuthority, stake
- proveAttestation (light client proof, checked locally)
- requestPrivateCheck, attestForeignEvent (EVM logs), attestForeignInstruction (Solana instructions), linkWallet, registerAgent, rateAgent, grantAgentKey and revokeAgentKey (function-call access keys), paidVerify (x402)
- Every method returns { success, data?, error?, txHash? } and never throws.

## CLI (@attestra/cli)
attestra schema|attestation|authority|storage|delegate|whitelist|fee|token-gated|token-reward|pipeline|credential|schedule|multisig|staking|token|blob|events|check|chain|agent|pay|ai ... --json

## REST API (indexer)
GET /api/stats, /api/status, /api/schemas, /api/schemas/:uid, /api/attestations?schema&attester&subject&status, /api/attestations/:uid, /api/authorities, /api/authorities/:account, /api/agents, /api/agents/:account, /api/events?event&account&uid, /api/profile/:account, /api/search?q

## Well-known schemas
${Object.entries(KNOWN_SCHEMAS).map(([k, s]) => `- ${s.name} (${knownSchemaUid(k as keyof typeof KNOWN_SCHEMAS)}): ${s.definition}`).join('\n')}

## Pages
- ${site}/docs: SDK, CLI, MCP, contracts, REST API
- ${site}/near: the NEAR-native features and their trust models
- ${site}/sandbox/app: every feature as a tool on testnet
- ${site}/attestations, ${site}/schemas, ${site}/authorities, ${site}/agents, ${site}/audit-log: explorer
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

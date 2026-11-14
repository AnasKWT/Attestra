import { DEPLOYMENT_DAOS, KNOWN_SCHEMAS, TOOLS, knownSchemaUid } from 'attestra';
import { AGENT_URL, CONTRACTS, INDEXER_URL, NET, NETWORK, REPO_URL, SITE_URL } from '@/lib/config';

export const dynamic = 'force-static';

export function GET() {
  const site = SITE_URL || '';
  const body = `# Attestra

> The trust layer for NEAR: a schema-based attestation protocol for issuing, managing and verifying claims about people, wallets on any chain, and AI agents. Private facts are checked by a NEAR AI Cloud verifiable model in a TEE and signed by a checker running in NEAR OutLayer's TEE with a key bound to its build, facts about EVM chains and Solana are verified by NEAR's MPC network without an oracle, agents get identity, delegation, scoped function-call keys and reputation, and any event can be proven final with a light client proof.

Source: ${REPO_URL} (MIT). Site: ${site || 'https://attestra.site'}.

Network: NEAR ${NETWORK}, live; a mainnet launch is planned (roadmap in MAINNET.md), the code selects it with NEAR_NETWORK=mainnet. Contracts (Rust, reproducible builds with NEP-330 metadata):
- schemas: ${CONTRACTS.schemas}
- attestations: ${CONTRACTS.attestations}
- verdicts (AI-checked facts, EVM and Solana facts, wallet links): ${CONTRACTS.verdicts}
- credentials (NEP-171, non-transferable): ${CONTRACTS.credentials}
- staking (NEP-141 tiers): ${CONTRACTS.staking}
- resolvers: ${Object.values(CONTRACTS.resolvers).join(', ')}
- token (NEP-141 test token with a faucet, for fees, rewards, staking and x402; native USDC on mainnet): ${CONTRACTS.token}
- MPC signer used for cross-chain facts: ${NET.mpc}
${DEPLOYMENT_DAOS[NETWORK] ? `- Sputnik DAO attester (membership attestations by council vote, or through a delegate grant its council voted, limited to the membership schema): ${DEPLOYMENT_DAOS[NETWORK]}\n` : ''}
## Concepts
- Schema: comma-separated "type name" fields (bool, u8..u128, i8..i128, string, account_id, bytes, bytes32, T[]). UID = sha256(borsh(("attestra:schema:v1", definition, resolver, revocable))).
- Attestation: attester, subject (NEAR account or CAIP-10), Borsh data, expiration, revocation, nonce. UID = sha256(borsh(("attestra:attestation:v1", schema_uid, subject, attester, data, nonce))).
- Status: pending, active, revoking, revoked, expired (expiry and scheduled revocation computed on read).
- Resolvers approve or refuse asynchronously; a refusal rolls the attestation back with a storage refund.
- DAO attesters: a Sputnik DAO issues an attestation through a FunctionCall proposal; once its council approves, the DAO account itself is the attester.

## Agent access
- MCP (Streamable HTTP, read tools): ${site}/mcp (claude mcp add --transport http attestra ${site}/mcp)
- MCP (stdio, read and capped write tools): node packages/mcp/dist/cli.js from a clone, or npx -y attestra-mcp
- Agent (chat, private checks, x402 paid verification): ${AGENT_URL}; A2A agent card: ${AGENT_URL}/.well-known/agent-card.json
- Indexer REST API: ${INDEXER_URL}
- Service health: ${site}/status
- Read tools (hosted and stdio): ${TOOLS.filter((t) => !t.write).map((t) => t.name).join(', ')}
- Write tools (stdio, with the caller's key and per-tool caps): ${TOOLS.filter((t) => t.write).map((t) => t.name).join(', ')}
- Agent skill: skills/attestra/SKILL.md in the repository${REPO_URL ? ` (${REPO_URL})` : ''}

## SDK (TypeScript, attestra)
- new AttestraClient({ network: 'testnet', accountId?, privateKey?, indexerUrl? })
- registerSchema, getSchema, createAttestation, getAttestation, isValid, revokeAttestation
- addDelegate, attestOnBehalf, signDelegatedAttestation (NEP-413), relaySigned
- mintCredential, scheduleRevocation, createMultisigAuthority, stake
- proposeDaoAttestation, voteDaoProposal, getDaoProposals, fundDaoStorage, createSputnikDao (Sputnik DAO attesters)
- proveAttestation (light client proof, checked locally)
- requestPrivateCheck, attestForeignEvent (EVM logs), attestForeignInstruction (Solana instructions), linkWallet, registerAgent, rateAgent, grantAgentKey and revokeAgentKey (function-call access keys), paidVerify (x402)
- Every method returns { success, data?, error?, txHash? } and never throws.

## CLI (attestra-cli)
attestra schema|attestation|authority|storage|delegate|whitelist|fee|token-gated|token-reward|pipeline|credential|schedule|multisig|dao|staking|token|blob|events|check|chain|agent|pay|ai ... --json

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

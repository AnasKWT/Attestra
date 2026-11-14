# attestra

TypeScript SDK for Attestra, the attestation protocol on NEAR: schemas, attestations, resolvers, delegation, credentials, private AI checks, cross-chain facts, Sputnik DAO attesters, Know Your Agent and light client proofs.

[Website](https://attestra.site) · [Docs](https://attestra.site/docs) · [Sandbox](https://attestra.site/sandbox/app) · [GitHub](https://github.com/AnasKWT/Attestra) · [llms.txt](https://attestra.site/llms.txt)

Attestra lets a fact be checked once and then read by any contract, app or agent, with a proof instead of a promise.
The contracts are live on NEAR testnet under `attestra.testnet`, built reproducibly and verifiable from source.

```bash
npm install attestra
```

ESM only, Node 22 or a modern browser.

## Read

```ts
import { AttestraClient } from 'attestra';

const client = new AttestraClient({ network: 'testnet' });
const valid = await client.isValid('<uid>');
const attestation = await client.getAttestation('<uid>');
const agent = await client.getAgentProfile('agent.testnet');
```

## Write

```ts
import { AttestraClient, SchemaEncoder } from 'attestra';

const client = new AttestraClient({ network: 'testnet', accountId: 'alice.testnet', privateKey: 'ed25519:...' });
const schema = await client.registerSchema({ definition: 'string name, u8 level', revocable: true });
const data = new SchemaEncoder('string name, u8 level').encode({ name: 'Bob', level: 3 });
const created = await client.createAttestation({ schemaUid: schema.data!.schemaUid, subject: 'bob.testnet', data });
```

Every method returns `{ success, data?, error?: { type, message }, txHash? }` and never throws.

## Scoped delegation to an agent

An account can give an AI agent its own NEAR function-call access key instead of a contract-level grant.
The key works only on the attestations contract, only for the attest and revoke methods, and only up to its gas allowance; it cannot move NEAR or attach a deposit.

```ts
await client.grantAgentKey('ed25519:<agent public key>');                     // attest, revoke, schedule_revocation; 0.25 NEAR of gas
await client.grantAgentKey(agentKey, { methods: ['attest'], allowanceNear: '0.1' });
const { data } = await client.agentKeys('alice.testnet');                    // which agents hold keys
await client.revokeAgentKey(agentKey);                                        // deletes only agent keys, never a full-access key
```

`methods` may only name methods in `AGENT_KEY_GRANTABLE_METHODS` (the attest and revoke family; never storage, delegation, signer keys or owner methods).
The agent then signs as the account, so keep a storage balance on the attestations contract (`storageDeposit('attestations', ...)`): a function-call key cannot attach the storage top-up.
`delegateToAgent` remains the contract-level alternative, with schema, expiry and use limits recorded on chain.

## Only on NEAR

```ts
// A private fact about your own account, checked by a NEAR AI Cloud model in NEAR OutLayer's TEE.
// The evidence is encrypted in this process; the request is signed with your key (NEP-413).
await client.requestPrivateCheck({ ruleId: 'age_over_18', subject: 'alice.testnet', evidence: 'Date of birth: 1990-04-12' });

// A Sputnik DAO as the attester: propose, and the DAO attests once its council approves.
await client.proposeDaoAttestation('guild.sputnik-v2.testnet', { schemaUid, subject: 'alice.testnet', data });

// An event on Base or Solana, verified by the NEAR MPC network (Chain Signatures), with no oracle.
await client.attestForeignEvent({ chain: 'base', txId, logIndex, log });

// An agent's identity and reputation: only reviews from accounts that paid it count as paid.
const profile = await client.getAgentProfile('agent.attestra.testnet');
```

## Also in the box

- `SchemaEncoder`: Borsh encoding for schema definitions such as `string name, u8 level, account_id issuer`.
- `computeSchemaUid`, `computeAttestationUid`: the same UIDs the contracts compute.
- `client.proveAttestation(uid)` and `proveReceipt`: prove an event is in a final block; the validator set is chained epoch by epoch from a checkpoint pinned in the SDK, so the RPC is not trusted.
- `openAITools()` and `runTool()`: Attestra as tools for any OpenAI-compatible agent; `attestra/ai` for LangChain (install the optional peers `@langchain/core` and `zod`).
- x402 helpers for paying for and serving verification on NEAR.
- Retries with exponential backoff that honour `Retry-After`, and a token-bucket rate limiter for services.

`network: 'mainnet'` switches every contract id, endpoint and token.

License: MIT.

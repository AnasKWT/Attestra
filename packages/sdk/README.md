# attestra

TypeScript SDK for Attestra, the attestation protocol on NEAR: schemas, attestations, resolvers, delegation, credentials, private AI checks, cross-chain facts, Know Your Agent and light client proofs.

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

## Also in the box

- `SchemaEncoder`: Borsh encoding for schema definitions such as `string name, u8 level, account_id issuer`.
- `computeSchemaUid`, `computeAttestationUid`: the same UIDs the contracts compute.
- `client.proveAttestation(uid)` and `proveReceipt`: prove an event is in a final block, checked against validator stake.
- `openAITools()` and `runTool()`: Attestra as tools for any OpenAI-compatible agent; `attestra/ai` for LangChain (install the optional peers `@langchain/core` and `zod`).
- x402 helpers for paying for and serving verification on NEAR.

`network: 'mainnet'` switches every contract id, endpoint and token.

License: MIT.

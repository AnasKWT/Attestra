# @attestra/sdk

TypeScript SDK for Attestra, the attestation protocol on NEAR: schemas, attestations, resolvers, delegation, credentials, private AI checks, cross-chain facts, Know Your Agent and light client proofs.

```bash
npm install @attestra/sdk
```

ESM only, Node 22 or a modern browser.

## Read

```ts
import { AttestraClient } from '@attestra/sdk';

const client = new AttestraClient({ network: 'testnet' });
const valid = await client.isValid('<uid>');
const attestation = await client.getAttestation('<uid>');
const agent = await client.getAgentProfile('agent.testnet');
```

## Write

```ts
import { AttestraClient, SchemaEncoder } from '@attestra/sdk';

const client = new AttestraClient({ network: 'testnet', accountId: 'alice.testnet', privateKey: 'ed25519:...' });
const schema = await client.registerSchema({ definition: 'string name, u8 level', revocable: true });
const data = new SchemaEncoder('string name, u8 level').encode({ name: 'Bob', level: 3 });
const created = await client.createAttestation({ schemaUid: schema.data!.schemaUid, subject: 'bob.testnet', data });
```

Every method returns `{ success, data?, error?: { type, message }, txHash? }` and never throws.

## Also in the box

- `SchemaEncoder`: Borsh encoding for schema definitions such as `string name, u8 level, account_id issuer`.
- `computeSchemaUid`, `computeAttestationUid`: the same UIDs the contracts compute.
- `client.proveAttestation(uid)` and `proveReceipt`: prove an event is in a final block, checked against validator stake.
- `openAITools()` and `runTool()`: Attestra as tools for any OpenAI-compatible agent; `@attestra/sdk/ai` for LangChain.
- x402 helpers for paying for and serving verification on NEAR.

`network: 'mainnet'` switches every contract id, endpoint and token.

License: MIT.

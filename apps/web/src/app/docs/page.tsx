import { DocsNav } from '@/components/docs/DocsNav';
import { CodeWindow, InlineCode } from '@/components/ui/Code';
import { Alert, Badge } from '@/components/ui/primitives';
import { CONTRACTS, NET } from '@/lib/config';

export const metadata = { title: 'Docs' };

const SECTIONS = [
  ['quick-start', 'Quick start'],
  ['concepts', 'Concepts'],
  ['sdk', 'SDK'],
  ['cli', 'CLI'],
  ['mcp', 'MCP server'],
  ['contracts', 'Contracts'],
  ['api', 'REST API'],
  ['encoding', 'Encoding and UIDs'],
  ['near', 'Only on NEAR'],
  ['networks', 'Networks'],
] as const;

const SDK_GROUPS: Array<[string, Array<[string, string]>]> = [
  ['Schemas', [['registerSchema({ definition, resolver?, revocable })', 'Register; returns the schema UID'], ['getSchema(uid)', 'Read a schema'], ['listSchemas({ authority?, limit?, offset? })', 'List (indexer, or the contract)'], ['storeSchemaBlob(definition)', 'Store a large definition (NEP-145)'], ['getSchemaBlob(hash)', 'Read a blob'], ['registerSchemaFromBlob({ blobHash, resolver?, revocable })', 'Register by blob hash']]],
  ['Attestations', [['createAttestation({ schemaUid, subject, data, expirationTime?, refUid? })', 'Attest; status created or rejected'], ['getAttestation(uid)', 'Read with live status'], ['isValid(uid)', 'Active right now?'], ['revokeAttestation(uid)', 'Revoke (attester only)'], ['listAttestations({ schemaUid?, attester?, subject?, status? })', 'List (indexer)'], ['getNonce(account)', 'Next attestation nonce']]],
  ['Authorities', [['registerAuthority(metadata, kind?)', 'Register or update'], ['getAuthority(account)', 'Record with tier'], ['setAuthorityVerification(account, verified)', 'Governance only'], ['getProfile(account)', 'Issued, received, schemas']]],
  ['Delegation', [['addDelegate(delegate, scope)', 'Grant with schemas, expiry, max uses, revoke right'], ['removeDelegate(delegate)', 'Remove a grant'], ['isDelegate(authority, delegate)', 'Active grant?'], ['getDelegates(authority)', 'All grants'], ['attestOnBehalf(params)', 'Attest as a delegate'], ['revokeOnBehalf(uid)', 'Revoke as a delegate'], ['addSignerKey(publicKey)', 'Key that may sign requests'], ['signDelegatedAttestation(params, signer)', 'NEP-413 request, off chain'], ['signDelegatedRevocation(params, signer)', 'NEP-413 revocation'], ['submitSigned(request)', 'Submit yourself'], ['relaySigned(request)', 'Relayer submits and pays']]],
  ['Resolvers', [['whitelistAdd / whitelistRemove / whitelistCheck', 'Per schema'], ['feeSetFee / feeGetFee / feeDeposit / feeGetBalance / feeCollected / feeWithdraw / feeWithdrawBalance', 'NEAR or NEP-141'], ['tokenGatedSetConfig / tokenGatedGetConfig', 'Minimum NEP-141 balance'], ['tokenRewardSetConfig / tokenRewardFund / tokenRewardGetConfig / tokenRewardGetDistributed', 'Pay subjects'], ['pipelineSetResolvers / pipelineGetResolvers', 'Chain resolvers'], ['resolverInfo(resolver) / schemaAdmin(resolver, uid)', 'Inspect']]],
  ['NEAR native', [['mintCredential(uid) / getCredential(uid) / listCredentials(owner)', 'NEP-171 credentials'], ['scheduleRevocation(uid, at) / getScheduledRevocation(uid) / finalizeRevocation(uid)', 'Scheduled revocation'], ['createMultisigAuthority / proposeMultisig / approveMultisig / executeMultisig / cancelMultisig / getMultisig / getProposal', 'k-of-n authorities'], ['stake / unstake / getStake / getTiers', 'Staking tiers'], ['faucet() / tokenBalance(account)', 'Test token'], ['listEvents(q) / proveAttestation(uid) / proveReceipt(id, receiver)', 'Audit trail and light client proofs']]],
  ['Only on NEAR', [['requestPrivateCheck({ ruleId, subject, evidence })', 'Private AI check'], ['attestForeignEvent({ chain, txId, logIndex, log })', 'Chain Signatures foreign tx'], ['linkWalletMessage / linkWallet / linkedAccount', 'Wallets on other chains'], ['registerAgent / delegateToAgent / rateAgent / getAgentProfile', 'Know Your Agent'], ['paidVerify(kind, target)', 'x402 paid verification']]],
];

const CLI: Array<[string, string]> = [
  ['schema', 'create, fetch, list, uid, known'],
  ['blob (large-schema)', 'store, fetch, register'],
  ['attestation', 'create, fetch, verify, list, revoke'],
  ['authority', 'register, fetch, verify'],
  ['profile', '<account>'],
  ['storage', 'deposit, balance, withdraw'],
  ['delegate', 'add, remove, list, check, attest, revoke, add-key, keys, sign, submit'],
  ['whitelist', 'add, remove, check, info'],
  ['fee', 'set-fee, get-fee, deposit, balance, collected, withdraw, refund'],
  ['token-gated', 'set-config, get-config'],
  ['token-reward', 'set-config, fund, get-config, distributed'],
  ['pipeline (cross-contract)', 'set, get'],
  ['credential', 'mint, fetch, list'],
  ['schedule', 'revoke, status, finalize'],
  ['multisig', 'create, propose-attest, propose-revoke, approve, execute, cancel, fetch, proposal'],
  ['staking', 'stake, unstake, info, tiers'],
  ['token', 'faucet, balance'],
  ['events', 'list, prove, prove-receipt'],
  ['check', 'run, rules'],
  ['chain', 'link-message, link, linked, attest-event'],
  ['agent', 'register, delegate, rate, profile'],
  ['pay', 'verify-claim, verify-agent'],
  ['encode / decode / config', 'offline helpers'],
  ['ai', 'ask in natural language (NEAR AI Cloud)'],
];

const MCP_TOOLS: Array<[string, string]> = [
  ['get_schema, list_schemas, well_known_schemas', 'read'],
  ['get_attestation, verify_attestation, list_attestations', 'read'],
  ['get_authority, get_delegates', 'read'],
  ['get_agent_reputation', 'read'],
  ['prove_attestation', 'read (light client proof)'],
  ['decode_data, compute_schema_uid', 'offline'],
  ['register_schema, create_attestation, revoke_attestation, rate_agent', 'write, capped per tool and per day'],
  ['request_private_check', 'write, capped'],
];

const API: Array<[string, string]> = [
  ['GET /api/stats', 'Counts'],
  ['GET /api/status', 'Indexer height, chain head, lag'],
  ['GET /api/schemas?authority&resolver&search&limit&offset', 'Schemas'],
  ['GET /api/schemas/:uid', 'One schema with its attestation count'],
  ['GET /api/attestations?schema&attester&subject&status&limit&offset', 'Attestations'],
  ['GET /api/attestations/:uid', 'One attestation, decoded'],
  ['GET /api/authorities?verified&kind', 'Authorities'],
  ['GET /api/authorities/:account', 'One authority with delegates'],
  ['GET /api/agents, /api/agents/:account', 'Know Your Agent profiles'],
  ['GET /api/events?event&contract&account&uid', 'NEP-297 audit trail'],
  ['GET /api/profile/:account', 'Issued, received, schemas'],
  ['GET /api/search?q', 'Universal search'],
];

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-24 border-b border-line pb-3 text-2xl font-semibold text-fg">
      <a href={`#${id}`} className="hover:text-accent">{children}</a>
    </h2>
  );
}

function Table({ head, rows, mono = true }: { head: [string, string]; rows: ReadonlyArray<readonly [string, string]>; mono?: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-panel">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-panel-2 font-mono text-[10.5px] uppercase tracking-wider text-mute">
            <th className="px-4 py-2.5">{head[0]}</th>
            <th className="px-4 py-2.5">{head[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([a, b]) => (
            <tr key={a} className="border-b border-line last:border-0">
              <td className={`px-4 py-2.5 align-top text-fg ${mono ? 'font-mono text-[12px]' : ''}`}>{a}</td>
              <td className="px-4 py-2.5 align-top text-soft">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Docs() {
  return (
    <div className="relative">
      <div className="spotlight pointer-events-none absolute inset-x-0 top-0 h-72 opacity-60" />
      <div className="relative mx-auto flex max-w-7xl gap-10 px-4 py-12 sm:px-6">
        <DocsNav sections={SECTIONS} />
        <article className="min-w-0 max-w-3xl flex-1 space-y-14">
          <header>
            <Badge tone="brand">Documentation</Badge>
            <h1 className="mt-4 text-4xl font-semibold text-fg">Build with Attestra</h1>
            <p className="mt-3 text-[15.5px] leading-relaxed text-soft">The SDK, the CLI, the MCP server, the contracts and the REST API. Everything here runs against NEAR testnet; one setting switches to mainnet.</p>
          </header>

          <section className="space-y-5">
            <H2 id="quick-start">Quick start</H2>
            <p className="text-[14.5px] text-soft">The packages are prepared for npm as <InlineCode>@attestra/sdk</InlineCode>, <InlineCode>@attestra/cli</InlineCode> and <InlineCode>@attestra/mcp</InlineCode>. From a clone of the repository:</p>
            <CodeWindow title="terminal" code={`pnpm install && pnpm build\n\n# read anything, no keys needed\npnpm --filter @attestra/cli exec attestra schema known\npnpm --filter @attestra/cli exec attestra attestation fetch <uid>\n\n# write with a testnet account from the NEAR CLI keychain\npnpm --filter @attestra/cli exec attestra -a you.testnet schema create \\\n  -d "string name, u8 level" --revocable`} />
            <CodeWindow title="read.ts" code={`import { AttestraClient } from '@attestra/sdk';\n\nconst client = new AttestraClient({ network: 'testnet' });\nconst r = await client.getAttestation(uid);\nif (r.success) console.log(r.data.status); // active, revoked, expired...`} />
          </section>

          <section className="space-y-5">
            <H2 id="concepts">Concepts</H2>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ['Schema', 'The fields of a claim, an optional resolver and whether it can be revoked. Its UID is deterministic.'],
                ['Attestation', 'A claim by an attester about a subject under a schema, with expiry, revocation and a nonce.'],
                ['Authority', 'An issuer that registered itself; governance can verify it; staking gives it a tier.'],
                ['Resolver', 'A contract that approves or refuses attestations and revocations for schemas that name it.'],
                ['Delegate', 'An account allowed to attest (and maybe revoke) for an authority, within a scope.'],
                ['Subject', 'A NEAR account or a CAIP-10 account on another chain.'],
              ].map(([t, b]) => (
                <div key={t} className="rounded-xl border border-line bg-panel p-4 shadow-panel">
                  <p className="font-display text-[15px] font-semibold text-fg">{t}</p>
                  <p className="mt-1 text-[13.5px] text-soft">{b}</p>
                </div>
              ))}
            </div>
            <Alert tone="info" title="Statuses">
              <InlineCode>pending</InlineCode> (waiting for a resolver), <InlineCode>active</InlineCode>, <InlineCode>revoking</InlineCode>, <InlineCode>revoked</InlineCode> (now or by schedule) and <InlineCode>expired</InlineCode>. Expiry and scheduled revocation are computed on every read.
            </Alert>
          </section>

          <section className="space-y-5">
            <H2 id="sdk">SDK</H2>
            <p className="text-[14.5px] text-soft">Every method returns <InlineCode>{'ServiceResponse<T>'}</InlineCode> (<InlineCode>success</InlineCode>, <InlineCode>data</InlineCode>, <InlineCode>error.type</InlineCode>, <InlineCode>txHash</InlineCode>) and never throws. Sign with a private key, a near-kit instance with a NEAR Connect wallet, or a key store.</p>
            <CodeWindow title="signing.ts" code={`// a key from env or the NEAR CLI keychain\nnew AttestraClient({ network: 'testnet', accountId: 'you.testnet', privateKey: process.env.KEY });\n\n// a browser wallet (NEAR Connect)\nimport { Near, fromHotConnect } from 'near-kit';\nconst near = new Near({ network: 'testnet', wallet: fromHotConnect(connector) });\nnew AttestraClient({ network: 'testnet', accountId, near, indexerUrl });`} />
            {SDK_GROUPS.map(([g, rows]) => (
              <div key={g} className="space-y-2">
                <h3 className="text-[16px] font-semibold text-fg">{g}</h3>
                <Table head={['Method', 'What it does']} rows={rows} />
              </div>
            ))}
            <h3 className="text-[16px] font-semibold text-fg">For agents</h3>
            <CodeWindow title="agent.ts" code={`import { getAttestraTools } from '@attestra/sdk/ai';       // LangChain\nimport { openAITools, runTool } from '@attestra/sdk';       // any OpenAI-compatible agent\n\nconst tools = openAITools();  // point the agent at https://cloud-api.near.ai/v1\nconst out = await runTool(client, 'verify_attestation', { uid });`} />
          </section>

          <section className="space-y-5">
            <H2 id="cli">CLI</H2>
            <p className="text-[14.5px] text-soft">Every command takes <InlineCode>--json</InlineCode>. Signing commands take <InlineCode>-a account</InlineCode> and read its key from <InlineCode>~/.near-credentials</InlineCode> or <InlineCode>ATTESTRA_PRIVATE_KEY</InlineCode>.</p>
            <Table head={['Group', 'Commands']} rows={CLI} />
          </section>

          <section className="space-y-5">
            <H2 id="mcp">MCP server</H2>
            <p className="text-[14.5px] text-soft">Run it with one line for Claude Code, Codex or Claude Desktop, or use the hosted endpoint at <InlineCode>/mcp</InlineCode> on this site (read tools).</p>
            <CodeWindow title="setup" code={`# Claude Code\nclaude mcp add attestra -- npx -y @attestra/mcp\n\n# Codex (~/.codex/config.toml)\n[mcp_servers.attestra]\ncommand = "npx"\nargs = ["-y", "@attestra/mcp"]\n\n# write tools: set ATTESTRA_ACCOUNT_ID and ATTESTRA_PRIVATE_KEY (testnet)`} />
            <Table head={['Tools', 'Kind']} rows={MCP_TOOLS} />
          </section>

          <section className="space-y-5">
            <H2 id="contracts">Contracts</H2>
            <p className="text-[14.5px] text-soft">Rust, near-sdk 5.30, reproducible builds with NEP-330 metadata. Testnet accounts:</p>
            <Table
              head={['Contract', 'Account']}
              rows={[
                ['schemas', CONTRACTS.schemas],
                ['attestations', CONTRACTS.attestations],
                ['verdicts', CONTRACTS.verdicts],
                ['credentials', CONTRACTS.credentials],
                ['staking', CONTRACTS.staking],
                ['token (testnet)', CONTRACTS.token],
                ['resolvers', Object.values(CONTRACTS.resolvers).join(', ')],
              ]}
            />
            <p className="text-[14px] text-soft">Verify any of them from a clone: <InlineCode>near contract verify deployed-at {CONTRACTS.attestations} network-config testnet now</InlineCode>.</p>
          </section>

          <section className="space-y-5">
            <H2 id="api">REST API</H2>
            <p className="text-[14.5px] text-soft">The indexer reads NEP-297 events from FastNEAR&apos;s transactions API and re-reads every touched record from the contracts.</p>
            <Table head={['Endpoint', 'Returns']} rows={API} />
          </section>

          <section className="space-y-5">
            <H2 id="encoding">Encoding and UIDs</H2>
            <CodeWindow title="uids" code={`schema UID      = sha256(borsh(("attestra:schema:v1", definition, resolver: Option<AccountId>, revocable)))\nattestation UID = sha256(borsh(("attestra:attestation:v1", schema_uid [32], subject, attester, data: Vec<u8>, nonce: u64)))`} />
            <p className="text-[14.5px] text-soft">Data is the Borsh encoding of the fields in order. Types: <InlineCode>bool</InlineCode>, <InlineCode>u8</InlineCode> to <InlineCode>u128</InlineCode>, <InlineCode>i8</InlineCode> to <InlineCode>i128</InlineCode>, <InlineCode>string</InlineCode>, <InlineCode>account_id</InlineCode>, <InlineCode>bytes</InlineCode>, <InlineCode>bytes32</InlineCode>, and lists with <InlineCode>[]</InlineCode>.</p>
          </section>

          <section className="space-y-5">
            <H2 id="near">Only on NEAR</H2>
            <p className="text-[14.5px] text-soft">Private AI checks, cross-chain facts, Know Your Agent, paid verification, gasless issuing and light client proofs, each with its trust model, are described on the <a className="text-accent hover:underline" href="/near">Only on NEAR</a> page.</p>
          </section>

          <section className="space-y-5">
            <H2 id="networks">Networks</H2>
            <Table
              head={['Setting', 'Testnet']}
              rows={[
                ['Switch', 'NEAR_NETWORK / NEXT_PUBLIC_NEAR_NETWORK = testnet | mainnet'],
                ['RPC', NET.rpcUrls[0]],
                ['MPC signer', NET.mpc],
                ['Payment token (x402)', NET.paymentToken],
                ['NEAR AI Cloud', 'https://cloud-api.near.ai/v1'],
                ['Explorer', NET.explorerUrl],
              ]}
            />
          </section>
        </article>
      </div>
    </div>
  );
}

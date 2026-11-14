/** The sandbox's tools, grouped as on the sandbox home. */

export interface ToolDef {
  slug: string;
  title: string;
  group: string;
  blurb: string;
  write: boolean;
}

export const GROUPS = ['Core', 'Delegation', 'Resolvers', 'Data', 'Retrieval', 'NEAR native', 'Only on NEAR', 'Agent'] as const;

export const TOOLS: ToolDef[] = [
  { slug: 'schema-builder', title: 'Schema Deployer', group: 'Core', blurb: 'Build a schema field by field and register it.', write: true },
  { slug: 'create-attestation', title: 'Create Attestation', group: 'Core', blurb: 'Issue a claim about a NEAR account or a wallet on any chain.', write: true },
  { slug: 'revoke', title: 'Revoke', group: 'Core', blurb: 'Revoke an attestation you issued.', write: true },
  { slug: 'register-authority', title: 'Register Authority', group: 'Core', blurb: 'Register yourself as an issuer.', write: true },
  { slug: 'verify-authority', title: 'Verify Authority', group: 'Core', blurb: 'Governance marks an authority verified.', write: true },
  { slug: 'delegated-attestation', title: 'Delegated Attestation', group: 'Delegation', blurb: 'Sign an attestation off chain (NEP-413); the relayer submits it.', write: true },
  { slug: 'delegated-revocation', title: 'Delegated Revocation', group: 'Delegation', blurb: 'Sign a revocation off chain; anyone submits it.', write: true },
  { slug: 'whitelist-manager', title: 'Whitelist', group: 'Resolvers', blurb: 'Only listed attesters may use a schema.', write: true },
  { slug: 'fee-resolver', title: 'Fee', group: 'Resolvers', blurb: 'Charge a fee per attestation, in NEAR or a NEP-141.', write: true },
  { slug: 'token-gated', title: 'Token Gated', group: 'Resolvers', blurb: 'Require a minimum NEP-141 balance to attest.', write: true },
  { slug: 'token-reward', title: 'Token Reward', group: 'Resolvers', blurb: 'Pay the subject a NEP-141 reward per attestation.', write: true },
  { slug: 'cross-contract', title: 'Pipeline', group: 'Resolvers', blurb: 'Chain resolvers with cross-contract calls and rollback.', write: true },
  { slug: 'schema-encoder', title: 'Schema Encoder', group: 'Data', blurb: 'Encode and decode attestation data offline.', write: false },
  { slug: 'wallet-attestations', title: 'Wallet Attestations', group: 'Data', blurb: 'Everything issued by or about an account.', write: false },
  { slug: 'wallet-schemas', title: 'Wallet Schemas', group: 'Data', blurb: 'Schemas an account registered.', write: false },
  { slug: 'schema-attestations', title: 'Schema Attestations', group: 'Data', blurb: 'Attestations under one schema.', write: false },
  { slug: 'lookup', title: 'Lookup', group: 'Retrieval', blurb: 'Read any schema or attestation from the chain.', write: false },
  { slug: 'search', title: 'Universal Search', group: 'Retrieval', blurb: 'Find schemas, attestations and accounts.', write: false },
  { slug: 'verify-proof', title: 'Light Client Proof', group: 'NEAR native', blurb: 'Prove an event is in a final block, in your browser.', write: false },
  { slug: 'nft-credential', title: 'Credential', group: 'NEAR native', blurb: 'Mint a non-transferable NEP-171 credential; it burns on revoke.', write: true },
  { slug: 'scheduled-revocation', title: 'Scheduled Revocation', group: 'NEAR native', blurb: 'Set a revoke time the contract enforces.', write: true },
  { slug: 'multisig-authority', title: 'Multisig Authority', group: 'NEAR native', blurb: 'A k-of-n authority enforced by the contract.', write: true },
  { slug: 'dao-attestation', title: 'DAO Attestation', group: 'NEAR native', blurb: 'A Sputnik DAO issues credentials by council vote or a grant it voted.', write: true },
  { slug: 'token-staking', title: 'Staking Tiers', group: 'NEAR native', blurb: 'Stake a NEP-141 for a Bronze, Silver or Gold tier.', write: true },
  { slug: 'file-schema', title: 'Large Schema', group: 'NEAR native', blurb: 'Store a large definition on chain with NEP-145 storage.', write: true },
  { slug: 'private-check', title: 'Private AI Check', group: 'Only on NEAR', blurb: 'Prove a private fact with a verifiable model in a TEE.', write: true },
  { slug: 'cross-chain', title: 'Cross-chain Fact', group: 'Only on NEAR', blurb: 'Attest an event on another chain, verified by the MPC network.', write: true },
  { slug: 'wallet-link', title: 'Wallet Link', group: 'Only on NEAR', blurb: 'Prove a wallet on another chain is yours.', write: true },
  { slug: 'agents', title: 'Know Your Agent', group: 'Only on NEAR', blurb: 'Register an agent, delegate to it, review it.', write: true },
  { slug: 'paid-verify', title: 'Paid Verification', group: 'Only on NEAR', blurb: 'Buy a verification per call over x402.', write: true },
  { slug: 'gasless', title: 'Gasless Issuing', group: 'Only on NEAR', blurb: 'Issue without NEAR: the relayer pays.', write: true },
  { slug: 'agent-chat', title: 'Agent Chat', group: 'Agent', blurb: 'Ask the protocol anything, on NEAR AI Cloud.', write: false },
];

export const toolBySlug = (slug: string) => TOOLS.find((t) => t.slug === slug);

/** The page title and description of a sandbox tool, for its folder's layout. */
export function toolMetadata(slug: string): { title: string; description: string } {
  const t = toolBySlug(slug);
  if (!t) throw new Error(`unknown sandbox tool ${slug}`);
  return { title: t.title, description: t.blurb };
}

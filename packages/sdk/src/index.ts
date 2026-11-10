/**
 * @attestra/sdk: the trust layer for NEAR.
 *
 * Schema-based attestations about people, wallets on any chain and AI agents: register schemas,
 * issue and revoke attestations, delegate issuing, add resolver rules, mint non-transferable
 * credentials, prove events with light client proofs, run private AI checks, attest facts about
 * other chains, and build agent reputation.
 */

export { AttestraClient } from './client';
export type { AttestraClientConfig } from './client';
export { AGENT_KEY_METHODS, AGENT_KEY_GRANTABLE_METHODS, AGENT_KEY_ALLOWANCE_NEAR, nearToYocto } from './agent-keys';
export type { AgentKey } from './agent-keys';
export * from './types';
export * from './config';
export { SchemaEncoder, parseSchema, isValidSchemaType, BASE_TYPES } from './encoder';
export { computeSchemaUid, computeAttestationUid, isUid, normalizeUid, SCHEMA_TAG, ATTESTATION_TAG } from './uid';
export { IndexerClient } from './indexer-client';
export type { AgentProfile, IndexerStats, IndexerStatus, SearchResult } from './indexer-client';
export { KNOWN_SCHEMAS, knownSchemaUid, knownSchemas } from './schemas';
export type { KnownSchema, KnownSchemaKey } from './schemas';
export { buildMessage, nep413Hash, signRequest, keySigner, verifyRequest, randomNonce, NEP413_TAG } from './nep413';
export type { DelegatedAction, DelegatedAttest, DelegatedRevoke, MessageSigner, SignedRequest } from './nep413';
export { proveReceipt, findEventReceipt, computeRootFromPath, blockHashFromHeader, outcomeHash, checkApprovals } from './lightclient';
export type { ProofResult, ProofCheck, LightClientProof } from './lightclient';
export { encryptForModel, decryptWithEd25519Seed } from './e2ee';
export { verdictDigest, foreignChainIds, foreignChainIdsTestnet, walletCaip10, EVM_CHAINS, fetchEvmLog, type EvmLog, SOLANA_RPC, SOLANA_DEVNET_REF, fetchSolanaInstruction, type SolanaInstruction } from './verdicts';
export type { AiVerdict } from './verdicts';
export * as x402 from './x402';
export { TOOLS, READ_TOOLS, WRITE_TOOLS, openAITools, runTool, defaultToolLimits } from './tools';
export type { ToolSpec, ToolLimits } from './tools';
export { classifyError, errorMessage } from './errors';
export { BorshWriter, BorshReader, bytesToHex, hexToBytes, bytesToBase64, base64ToBytes, base58Encode, base58Decode } from './borsh';
export { PREFERRED_MODELS, verifiableModels, pickVerifiableModel } from './models';

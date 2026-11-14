/**
 * attestra: the trust layer for NEAR.
 *
 * Schema-based attestations about people, wallets on any chain and AI agents: register schemas,
 * issue and revoke attestations, delegate issuing, add resolver rules, mint non-transferable
 * credentials, prove events with light client proofs, run private AI checks, attest facts about
 * other chains, and build agent reputation.
 */

export { AttestraClient } from './client';
export type { AttestraClientConfig, DaoVoteResult } from './client';
export {
  SPUTNIK_FACTORIES,
  DEPLOYMENT_DAOS,
  DAO_ACTION_GAS,
  DAO_MAX_ACTION_GAS,
  DAO_CREATE_DEPOSIT,
  daoAttestProposal,
  daoRevokeProposal,
  daoPolicyProposal,
  daoDelegateProposal,
  daoRemoveDelegateProposal,
  daoMembershipMessage,
  signDaoMembership,
  verifyDaoMembershipRequest,
  parseDaoCall,
  isSputnikDao,
  daoCan,
  daoCouncil,
  daoApprovalsNeeded,
  attestingDaoPolicy,
  sputnikCreateArgs,
  attestraEvents,
  receiptFailure,
} from './dao';
export type { DaoMembershipRequest, DaoDelegateScope } from './dao';
export type { DaoActionCall, DaoAttestRequest, DaoConfig, DaoPolicy, DaoProposal, DaoProposalInput, DaoProposalKind, DaoProposalStatus, DaoRole, DaoVote, DaoVotePolicy, ParsedDaoCall } from './dao';
export { AGENT_KEY_METHODS, AGENT_KEY_GRANTABLE_METHODS, AGENT_KEY_ALLOWANCE_NEAR, nearToYocto } from './agent-keys';
export type { AgentKey } from './agent-keys';
export * from './types';
export * from './config';
export { SchemaEncoder, parseSchema, isValidSchemaType, BASE_TYPES } from './encoder';
export { computeSchemaUid, computeAttestationUid, isUid, normalizeUid, SCHEMA_TAG, ATTESTATION_TAG } from './uid';
export { IndexerClient } from './indexer-client';
export type { AgentProfile, AgentReview, IndexerStats, IndexerStatus, SearchResult } from './indexer-client';
export {
  EXCLUSION_REASONS,
  TRUSTED_MIN_PAID_AVERAGE,
  NEAR_ASSET,
  isSubAccount,
  inAccountTree,
  judgeIdentity,
  pickIdentity,
  isTxHash,
  txPayments,
  lookupFromTx,
  judgePayment,
  paymentQueries,
  agentTrust,
  evaluateReputation,
  assessReputation,
  MemoryTxCache,
  rpcTxLookup,
  recentPayments,
} from './reputation';
export type {
  AgentReputation,
  AgentTrust,
  AttestationLike,
  CachedTxLookup,
  ExclusionReason,
  IdentityStatus,
  IdentityVerdict,
  PaymentVerdict,
  ReputationOptions,
  ReputationReview,
  RpcCall,
  RpcTxResult,
  TxLookup,
  TxLookupCache,
  TxLookupFn,
  TxPayment,
} from './reputation';
export { KNOWN_SCHEMAS, knownSchemaUid, knownSchemas } from './schemas';
export type { KnownSchema, KnownSchemaKey } from './schemas';
export { buildMessage, nep413Hash, signRequest, keySigner, verifyRequest, randomNonce, NEP413_TAG } from './nep413';
export type { DelegatedAction, DelegatedAttest, DelegatedRevoke, MessageSigner, SignedRequest } from './nep413';
export {
  proveReceipt,
  findEventReceipt,
  computeRootFromPath,
  blockHashFromHeader,
  outcomeHash,
  checkApprovals,
  blockProducersHash,
  headFromCheckpoint,
  advanceHead,
  syncLightClient,
  createLightClientCache,
  LightClientError,
} from './lightclient';
export type { ProofResult, ProofCheck, LightClientProof, LightClientBlock, ValidatorStakeView, TrustedHead, LightClientCache, ProveOptions } from './lightclient';
export { CHECKPOINTS, type LightClientCheckpoint } from './checkpoints';
export { encryptForModel, decryptWithEd25519Seed } from './e2ee';
export { signPrivateCheck, verifySubjectProof, privateCheckMessage, evidenceSha256, githubOwnerAgrees, GIST_FILE, MAX_PROOF_AGE_SECS } from './subject-proof';
export type { SubjectProof, PrivateCheckRequest } from './subject-proof';
export { verdictDigest, foreignChainIds, foreignChainIdsTestnet, walletCaip10, EVM_CHAINS, fetchEvmLog, type EvmLog, SOLANA_RPC, SOLANA_DEVNET_REF, fetchSolanaInstruction, type SolanaInstruction } from './verdicts';
export type { AiVerdict } from './verdicts';
export * as x402 from './x402';
export { TOOLS, READ_TOOLS, WRITE_TOOLS, openAITools, runTool, defaultToolLimits } from './tools';
export type { ToolSpec, ToolLimits } from './tools';
export { classifyError, errorMessage } from './errors';
export { BorshWriter, BorshReader, bytesToHex, hexToBytes, bytesToBase64, base64ToBytes, base58Encode, base58Decode } from './borsh';
export { PREFERRED_MODELS, verifiableModels, pickVerifiableModel } from './models';
export { withRetry, fetchWithRetry, isTransient, retryAfterMs, RetryableStatus, RETRY_STATUSES, NOT_PROCESSED_STATUSES, type RetryOptions } from './retry';
export {
  TokenBucket,
  DailyBudget,
  takeAll,
  rateLimit,
  rateLimitHeaders,
  tooManyRequests,
  refusalMessage,
  parseRate,
  describeRate,
  clientAddress,
  addressKey,
  remoteAddress,
  trustProxySetting,
  RATE_LIMIT_HEADERS,
} from './ratelimit';
export type { Rate, Limiter, LimiterOptions, LimitDecision, LimitEntry, CombinedDecision, RateLimitContext, RateLimitRule } from './ratelimit';

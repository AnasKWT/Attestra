/**
 * The subject's consent to a private check. A check attests a fact about one NEAR account, so
 * that account's key signs a NEP-413 request naming the rule, the subject, the SHA-256 of the
 * exact encrypted evidence, the GitHub login (if any) and a deadline, for the verdicts contract
 * as recipient. The checker in OutLayer's TEE verifies it (`checker/src/proof.rs`) and so does the
 * agent before it spends anything; without it, one person's evidence could mark any account.
 *
 * GitHub rules also need the login's owner to agree: a public gist of that login with a file
 * `attestra.txt` containing the line `attestra:<subject>`.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Decode, bytesToBase64, bytesToHex } from './borsh';
import { nep413Hash, randomNonce, type MessageSigner } from './nep413';

/** The longest a signed check request may stay valid, in seconds. */
export const MAX_PROOF_AGE_SECS = 86_400;
/** The gist file a GitHub login's owner publishes to agree to checks about a NEAR account. */
export const GIST_FILE = 'attestra.txt';

/** What the agent and the checker take as `subject_proof`. */
export interface SubjectProof {
  /** The exact JSON text the key signed. */
  message: string;
  /** base64 of 32 bytes */
  nonce: string;
  /** `ed25519:<base58>` */
  public_key: string;
  /** base64 of 64 bytes */
  signature: string;
}

export interface PrivateCheckRequest {
  ruleId: string;
  subject: string;
  /** The evidence exactly as sent: hex ciphertext to the model key, or empty for GitHub rules. */
  encryptedEvidence: string;
  github?: string | null;
  /** Unix seconds; defaults to ten minutes from now. */
  deadline?: number;
}

/** SHA-256 (hex) of the evidence field as sent. */
export function evidenceSha256(encryptedEvidence: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(encryptedEvidence)));
}

/** The exact text a subject signs; key order is fixed so the checker can verify it. */
export function privateCheckMessage(p: PrivateCheckRequest & { deadline: number }): string {
  return JSON.stringify({
    action: 'private_check',
    rule_id: p.ruleId,
    subject: p.subject,
    evidence_sha256: evidenceSha256(p.encryptedEvidence),
    github: p.github || null,
    deadline: p.deadline,
  });
}

function signatureBytes(signature: string): Uint8Array {
  const raw = signature.includes(':') ? signature.split(':')[1] : signature;
  try {
    const b = base58Decode(raw);
    if (b.length === 64) return b;
  } catch {
    // not base58
  }
  return Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
}

/** Signs a private check request with the subject's key (a wallet, a passkey or a raw key). */
export async function signPrivateCheck(signer: MessageSigner, p: PrivateCheckRequest, recipient: string): Promise<SubjectProof> {
  const deadline = p.deadline ?? Math.floor(Date.now() / 1000) + 600;
  const message = privateCheckMessage({ ...p, deadline });
  const nonce = randomNonce();
  const signed = await signer.signMessage({ message, recipient, nonce });
  return { message, nonce: bytesToBase64(nonce), public_key: signed.publicKey, signature: bytesToBase64(signatureBytes(signed.signature)) };
}

const isImplicit = (a: string) => /^[0-9a-f]{64}$/.test(a);
const isNearAccount = (a: string) => a.length >= 2 && a.length <= 64 && /^[a-z0-9._-]+$/.test(a) && !/^[._-]/.test(a);

/**
 * Checks a proof the way the checker does. `hasFullAccessKey` reads the chain (the agent passes
 * an RPC lookup); an implicit account needs none, its key is its name. Throws the reason.
 */
export async function verifySubjectProof(p: {
  proof: SubjectProof | undefined | null;
  ruleId: string;
  subject: string;
  encryptedEvidence: string;
  github?: string | null;
  recipient: string;
  hasFullAccessKey: (accountId: string, publicKey: string) => Promise<boolean>;
  now?: number;
}): Promise<void> {
  if (!isNearAccount(p.subject)) throw new Error('a private check is about a NEAR account');
  const proof = p.proof;
  if (!proof) throw new Error('the subject must sign the request (subject_proof)');
  let m: { action?: string; rule_id?: string; subject?: string; evidence_sha256?: string; github?: string | null; deadline?: number };
  try {
    m = JSON.parse(proof.message);
  } catch {
    throw new Error('the signed message is not a private check request');
  }
  if (m.action !== 'private_check') throw new Error('the signed message is not a private check request');
  if (m.rule_id !== p.ruleId || m.subject !== p.subject) throw new Error('the signed message names another rule or subject');
  if (m.evidence_sha256 !== evidenceSha256(p.encryptedEvidence)) throw new Error('the signed message names other evidence');
  if ((m.github || null) !== (p.github || null)) throw new Error('the signed message names another GitHub login');
  const now = p.now ?? Math.floor(Date.now() / 1000);
  if (typeof m.deadline !== 'number' || m.deadline < now) throw new Error('the signed request has expired');
  if (m.deadline > now + MAX_PROOF_AGE_SECS) throw new Error('the signed request is valid for more than a day');
  if (!proof.public_key.startsWith('ed25519:')) throw new Error('the subject key must be ed25519');
  const key = base58Decode(proof.public_key.slice(8));
  const nonce = Uint8Array.from(atob(proof.nonce), (c) => c.charCodeAt(0));
  const sig = Uint8Array.from(atob(proof.signature), (c) => c.charCodeAt(0));
  if (key.length !== 32 || nonce.length !== 32 || sig.length !== 64) throw new Error('the subject proof is malformed');
  if (!ed25519.verify(sig, nep413Hash(proof.message, nonce, p.recipient), key)) throw new Error("the subject's signature does not verify");
  if (isImplicit(p.subject)) {
    if (bytesToHex(key) !== p.subject) throw new Error('the key is not the one this implicit account is made of');
    return;
  }
  if (!(await p.hasFullAccessKey(p.subject, proof.public_key))) throw new Error(`${proof.public_key} is not a full-access key of ${p.subject}`);
}

/** Whether `login` published a gist `attestra.txt` with the line `attestra:<subject>`. Throws the reason. */
export async function githubOwnerAgrees(login: string, subject: string, opts: { token?: string; fetch?: typeof fetch } = {}): Promise<void> {
  const f = opts.fetch ?? fetch;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'attestra-checker', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) };
  const res = await f(`https://api.github.com/users/${login}/gists?per_page=100`, { headers });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the gists of ${login}`);
  const gists = (await res.json()) as Array<{ files?: Record<string, { raw_url?: string }> }>;
  const wanted = `attestra:${subject}`;
  for (const g of gists) {
    const url = g.files?.[GIST_FILE]?.raw_url;
    if (!url || !url.startsWith('https://gist.githubusercontent.com/')) continue;
    const raw = await f(url, { headers: { 'user-agent': 'attestra-checker' } });
    if (raw.ok && (await raw.text()).split('\n').some((l) => l.trim() === wanted)) return;
  }
  throw new Error(`${login} has no public gist ${GIST_FILE} with the line ${wanted}`);
}

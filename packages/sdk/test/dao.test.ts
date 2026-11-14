import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  attestingDaoPolicy,
  attestraEvents,
  base64ToBytes,
  daoApprovalsNeeded,
  daoAttestProposal,
  daoCan,
  daoCouncil,
  daoDelegateProposal,
  daoPolicyProposal,
  daoRemoveDelegateProposal,
  keySigner,
  base58Encode,
  bytesToHex,
  signDaoMembership,
  verifyDaoMembershipRequest,
  daoRevokeProposal,
  isSputnikDao,
  parseDaoCall,
  receiptFailure,
  sputnikCreateArgs,
  type DaoPolicy,
} from '../src';

const A = 'attestations.attestra.testnet';
const S = 'ab'.repeat(32);

describe('Sputnik DAO proposals', () => {
  it('builds an attest proposal the DAO will call as itself, and reads it back', () => {
    const p = daoAttestProposal(A, { schemaUid: `0x${S.toUpperCase()}`, subject: 'alice.testnet', data: 'AQID', expirationTime: 1_900_000_000 });
    const action = (p.kind as { FunctionCall: { receiver_id: string; actions: Array<{ method_name: string; args: string; deposit: string; gas: string }> } }).FunctionCall;
    expect(action.receiver_id).toBe(A);
    expect(action.actions).toHaveLength(1);
    expect(action.actions[0]).toMatchObject({ method_name: 'attest', deposit: '0', gas: '150000000000000' });
    expect(JSON.parse(new TextDecoder().decode(base64ToBytes(action.actions[0].args)))).toEqual({ schema_uid: S, subject: 'alice.testnet', data: 'AQID', expiration_time: 1_900_000_000, ref_uid: null });
    expect(parseDaoCall(p.kind, A)).toEqual({ method: 'attest', schemaUid: S, subject: 'alice.testnet', data: 'AQID', expirationTime: 1_900_000_000, refUid: null, deposit: '0', gas: '150000000000000' });
    expect(p.description).toMatch(/alice\.testnet/);

    const r = daoRevokeProposal(A, S, { description: 'left the guild' });
    expect(r.description).toBe('left the guild');
    expect(parseDaoCall(r.kind, A)).toMatchObject({ method: 'revoke', uid: S });
  });

  it('refuses gas the vote could not carry', () => {
    expect(() => daoAttestProposal(A, { schemaUid: S, subject: 'a', data: '', gas: 260n * 10n ** 12n })).toThrow(/Tgas/);
    expect(() => daoRevokeProposal(A, S, { gas: 0n })).toThrow(/Tgas/);
  });

  it('reads anything that is not one attest or revoke on the contract as null', () => {
    const p = daoAttestProposal(A, { schemaUid: S, subject: 'a.testnet', data: 'AQ==' });
    expect(parseDaoCall(p.kind, 'other.testnet')).toBeNull();
    expect(parseDaoCall('ChangeConfig', A)).toBeNull();
    expect(parseDaoCall({ Transfer: { receiver_id: 'x', amount: '1' } }, A)).toBeNull();
    const fc = (p.kind as { FunctionCall: { receiver_id: string; actions: Array<{ method_name: string; args: string; deposit: string; gas: string }> } }).FunctionCall;
    expect(parseDaoCall({ FunctionCall: { ...fc, actions: [fc.actions[0], fc.actions[0]] } }, A)).toBeNull();
    expect(parseDaoCall({ FunctionCall: { ...fc, actions: [{ ...fc.actions[0], method_name: 'storage_withdraw' }] } }, A)).toBeNull();
    expect(parseDaoCall({ FunctionCall: { ...fc, actions: [{ ...fc.actions[0], args: '!!notbase64' }] } }, A)).toBeNull();
    expect(parseDaoCall({ FunctionCall: { ...fc, actions: [{ ...fc.actions[0], args: btoa('{"schema_uid":"zz","subject":"a","data":""}') }] } }, A)).toBeNull();
  });

  it('knows Sputnik DAO accounts by their factory', () => {
    expect(isSputnikDao('attestra.sputnik-v2.testnet')).toBe(true);
    expect(isSputnikDao('guild.sputnik-dao.near', 'mainnet')).toBe(true);
    expect(isSputnikDao('guild.sputnik-dao.near', 'testnet')).toBe(false);
    expect(isSputnikDao('sputnik-v2.testnet')).toBe(false);
    expect(isSputnikDao('a.b.sputnik-v2.testnet')).toBe(false);
    expect(isSputnikDao('alice.testnet')).toBe(false);
  });
});

describe('Sputnik DAO policy', () => {
  const policy = attestingDaoPolicy(['keeper.attestra.testnet', 'attestra.testnet']);

  it('lets anyone propose calls and only the council vote', () => {
    expect(daoCan(policy, 'stranger.testnet', 'AddProposal')).toBe(true);
    expect(daoCan(policy, 'stranger.testnet', 'AddProposal', 'transfer')).toBe(false);
    expect(daoCan(policy, 'stranger.testnet', 'VoteApprove')).toBe(false);
    expect(daoCan(policy, 'attestra.testnet', 'VoteApprove')).toBe(true);
    expect(daoCouncil(policy)).toEqual(['keeper.attestra.testnet', 'attestra.testnet']);
    expect(policy.proposal_bond).toBe('10000000000000000000000');
  });

  it('counts approvals the way Sputnik does', () => {
    const council = policy.roles[1];
    expect(daoApprovalsNeeded(policy, council)).toBe(1);
    expect(daoApprovalsNeeded(attestingDaoPolicy(['a', 'b', 'c'], { approvals: 2 }), council)).toBe(2);
    const ratio: DaoPolicy = { ...policy, default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] } };
    expect(daoApprovalsNeeded(ratio, council)).toBe(2);
    expect(daoApprovalsNeeded(ratio, { ...council, kind: { Group: ['a', 'b', 'c', 'd', 'e'] } })).toBe(3);
    expect(daoApprovalsNeeded(policy, policy.roles[0])).toBeNull();
    expect(() => attestingDaoPolicy([])).toThrow();
    expect(() => attestingDaoPolicy(['a'], { approvals: 2 })).toThrow();
  });

  it('grants issuing through a scoped delegate, not a voting role', () => {
    const p = daoDelegateProposal(A, 'keeper.attestra.testnet', { schemas: [S], expiresAt: 1_900_000_000, maxUses: 100 });
    const call = (p.kind as { FunctionCall: { receiver_id: string; actions: Array<{ method_name: string; args: string }> } }).FunctionCall;
    expect(call.receiver_id).toBe(A);
    expect(call.actions[0].method_name).toBe('add_delegate');
    expect(JSON.parse(new TextDecoder().decode(base64ToBytes(call.actions[0].args)))).toEqual({
      delegate: 'keeper.attestra.testnet',
      scope: { schemas: [S], expires_at: 1_900_000_000, max_uses: 100, can_revoke: false, label: 'issues on behalf of the DAO' },
    });
    expect(attestingDaoPolicy(['attestra.testnet']).roles.map((r) => r.name)).toEqual(['all', 'council']);
    expect(daoPolicyProposal(attestingDaoPolicy(['a'])).kind).toEqual({ ChangePolicy: { policy: attestingDaoPolicy(['a']) } });
    const removal = daoRemoveDelegateProposal(A, 'keeper.attestra.testnet').kind as { FunctionCall: { actions: Array<{ method_name: string }> } };
    expect(removal.FunctionCall.actions[0].method_name).toBe('remove_delegate');
  });

  it('signs and verifies membership requests by the account itself', async () => {
    const seed = new Uint8Array(32).fill(5);
    const signer = keySigner(`ed25519:${base58Encode(seed)}`);
    const now = 1_790_000_000;
    const req = await signDaoMembership(signer, { dao: 'attestra.sputnik-v2.testnet', account: 'bob.testnet', role: 'member', deadline: now + 600 }, A);
    expect(JSON.parse(req.message)).toEqual({ action: 'dao_membership', dao: 'attestra.sputnik-v2.testnet', account: 'bob.testnet', role: 'member', deadline: now + 600 });
    const owns = (account: string, key: string) => Promise.resolve(account === 'bob.testnet' && key === signer.publicKey);
    expect(await verifyDaoMembershipRequest(req, { attestations: A, hasFullAccessKey: owns, now })).toEqual({ dao: 'attestra.sputnik-v2.testnet', account: 'bob.testnet', role: 'member' });
    await expect(verifyDaoMembershipRequest(req, { attestations: 'other.testnet', hasFullAccessKey: owns, now })).rejects.toThrow(/does not verify/);
    await expect(verifyDaoMembershipRequest(req, { attestations: A, hasFullAccessKey: () => Promise.resolve(false), now })).rejects.toThrow(/full-access key/);
    await expect(verifyDaoMembershipRequest(req, { attestations: A, hasFullAccessKey: owns, now: now + 601 })).rejects.toThrow(/expired/);
    await expect(verifyDaoMembershipRequest({ ...req, message: req.message.replace('"role":"member"', '"role":"admin"') }, { attestations: A, hasFullAccessKey: owns, now })).rejects.toThrow(/does not verify/);
    const implicit = bytesToHex(ed25519.getPublicKey(seed));
    const own = await signDaoMembership(signer, { dao: 'd.sputnik-v2.testnet', account: implicit, role: 'member', deadline: now + 60 }, A);
    expect((await verifyDaoMembershipRequest(own, { attestations: A, hasFullAccessKey: () => Promise.reject(new Error('no lookup')), now })).account).toBe(implicit);
  });

  it('encodes the factory arguments', () => {
    const { name, args } = sputnikCreateArgs({ name: 'guild', purpose: 'p', policy });
    expect(name).toBe('guild');
    expect(JSON.parse(new TextDecoder().decode(base64ToBytes(args)))).toEqual({ config: { name: 'guild', purpose: 'p', metadata: '' }, policy });
    expect(() => sputnikCreateArgs({ name: 'Guild!', purpose: 'p', policy })).toThrow();
  });
});

describe('transaction outcomes', () => {
  it('collects Attestra events and the first failure from every receipt', () => {
    const line = (event: string, uid: string) => `EVENT_JSON:${JSON.stringify({ standard: 'attestra', version: '1.0.0', event, data: [{ uid }] })}`;
    const outcome = {
      transaction_outcome: { outcome: { logs: [] } },
      receipts_outcome: [
        { outcome: { logs: ['plain log', 'EVENT_JSON:{bad', `EVENT_JSON:${JSON.stringify({ standard: 'nep171', event: 'nft_mint', data: [] })}`] } },
        { outcome: { logs: [line('attestation_created', 'ee')], status: { SuccessValue: '' } } },
        { outcome: { logs: [], status: { Failure: { ActionError: { kind: 'x' } } } } },
      ],
    };
    expect(attestraEvents(outcome)).toEqual([{ event: 'attestation_created', data: [{ uid: 'ee' }] }]);
    expect(receiptFailure(outcome)).toContain('ActionError');
    expect(receiptFailure({ receipts_outcome: [] })).toBeNull();
    expect(attestraEvents(undefined)).toEqual([]);
  });
});

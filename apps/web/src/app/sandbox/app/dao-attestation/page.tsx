'use client';

import { useState } from 'react';
import { AttestraErrorType, DEPLOYMENT_DAOS, KNOWN_SCHEMAS, SchemaEncoder, daoApprovalsNeeded, knownSchemaUid, type ServiceResponse } from '@attestra/sdk';
import { AccountLink, UidLink } from '@/components/explorer/Links';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select } from '@/components/ui/Field';
import { Badge, KeyValue, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import { useWallet } from '@/components/wallet/WalletProvider';
import { indexer, reader } from '@/lib/client';
import { KEEPER_URL, NETWORK } from '@/lib/config';
import { useAsync } from '@/lib/useFetch';

const DEFAULT_DAO = DEPLOYMENT_DAOS[NETWORK] ?? '';
const MEMBERSHIP = knownSchemaUid('membership');
const encoder = new SchemaEncoder(KNOWN_SCHEMAS.membership.definition);
const ROLES = [
  { value: 'member', note: 'approved by the keeper' },
  { value: 'contributor', note: 'approved by the keeper' },
  { value: 'maintainer', note: 'waits for a human vote' },
];

interface Reviewed {
  dao: string;
  id: number;
  decision: 'approve' | 'reject' | 'skip';
  reason: string;
  status?: string;
  tx?: string;
  attestation?: string;
}

/** Asks the keeper, the DAO's reviewer, to review the DAO's open proposals now, and returns its verdict on one. */
async function councilReview(dao: string, id: number): Promise<ServiceResponse<Reviewed>> {
  const res = await fetch(`${KEEPER_URL}/v1/dao/review`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; reviewed?: Reviewed[] };
  if (!res.ok || !body.ok) return { success: false, error: { type: AttestraErrorType.NETWORK_ERROR, message: body.error ?? `the keeper answered ${res.status}` } };
  const mine = body.reviewed?.find((r) => r.dao === dao && r.id === id);
  if (mine) return { success: true, data: mine, ...(mine.tx ? { txHash: mine.tx } : {}) };
  // Reviewed in an earlier pass (the keeper also reviews every 30 seconds): read the outcome from the DAO.
  const p = await reader().getDaoProposal(dao, id);
  if (!p.success || !p.data) return { success: false, error: p.error ?? { type: AttestraErrorType.NOT_FOUND, message: 'proposal not found' } };
  const decided = p.data.status !== 'InProgress';
  const call = p.data.call;
  let attestation: string | undefined;
  if (p.data.status === 'Approved' && call?.method === 'attest') {
    const issued = await indexer.listAttestations({ attester: dao, subject: call.subject, schema: call.schemaUid, limit: 50 }).catch(() => null);
    attestation = issued?.data.find((a) => a.data === call.data)?.uid;
  }
  return {
    success: true,
    data: { dao, id, decision: decided ? (p.data.status === 'Approved' ? 'approve' : 'reject') : 'skip', reason: decided ? `already ${p.data.status}` : 'not reviewed by the keeper: it waits for a human council vote', status: p.data.status, ...(attestation ? { attestation } : {}) },
  };
}

function Verdict({ r }: { r: Reviewed }) {
  const tone = r.status === 'Approved' ? 'ok' : r.status === 'InProgress' || r.decision === 'skip' ? 'neutral' : 'bad';
  return (
    <div className="space-y-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{r.status ?? r.decision}</Badge>
        <span className="text-soft">{r.reason}</span>
      </div>
      {r.attestation && (
        <KeyValue label="Issued by the DAO">
          <UidLink uid={r.attestation} kind="attestations" />
        </KeyValue>
      )}
    </div>
  );
}

function DaoCard({ dao }: { dao: string }) {
  const info = useAsync(async () => {
    const [config, policy] = await Promise.all([reader().getDaoConfig(dao), reader().getDaoPolicy(dao)]);
    if (!policy.success || !policy.data) throw new Error(policy.error?.message ?? 'not a Sputnik DAO');
    // Every named role that can approve a function call, with the votes that decide one and whether it can do more.
    const voters = policy.data.roles.flatMap((r) =>
      typeof r.kind === 'object' && 'Group' in r.kind && r.permissions.some((p) => ['*:*', 'call:*', '*:VoteApprove', 'call:VoteApprove'].includes(p))
        ? [{ name: r.name, members: r.kind.Group, approvals: daoApprovalsNeeded(policy.data!, r), onlyCalls: !r.permissions.some((p) => p.startsWith('*:')) }]
        : [],
    );
    return { purpose: config.data?.purpose ?? '', voters, bond: Number(BigInt(policy.data.proposal_bond)) / 1e24 };
  }, [dao]);
  return (
    <Panel>
      <PanelHeader title="The DAO" subtitle="A Sputnik DAO v2 created by the factory; its policy says who may propose and vote" right={<Badge tone="brand">Sputnik DAO</Badge>} />
      <dl className="px-5 py-2">
        {info.loading && <Skeleton className="my-3 h-16" />}
        {info.error && <p className="py-3 text-[13px] text-red-600 dark:text-red-400">{info.error}</p>}
        {info.data && (
          <>
            <KeyValue label="Account">
              <AccountLink id={dao} />
            </KeyValue>
            {info.data.voters.map((v) => (
              <KeyValue key={v.name} label={<span className="capitalize">{v.name}</span>}>
                <span className="flex flex-col gap-1.5">
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {v.members.map((m) => (
                      <AccountLink key={m} id={m} />
                    ))}
                  </span>
                  <span className="text-[12.5px] text-mute">
                    {v.approvals === null ? 'token-weighted votes' : `${v.approvals} ${v.approvals === 1 ? 'vote decides' : 'votes decide'}`}
                    {v.onlyCalls ? ' a function call; cannot vote on anything else' : ' any proposal'}
                  </span>
                </span>
              </KeyValue>
            ))}
            <KeyValue label="Proposal bond">{info.data.bond} NEAR, returned once decided</KeyValue>
            {info.data.purpose && <KeyValue label="Purpose">{info.data.purpose}</KeyValue>}
          </>
        )}
      </dl>
    </Panel>
  );
}

export default function DaoAttestation() {
  const w = useWallet();
  const [dao, setDao] = useState(DEFAULT_DAO);
  const [role, setRole] = useState('member');
  const [pid, setPid] = useState('');
  const [vote, setVote] = useState<'VoteApprove' | 'VoteReject'>('VoteApprove');
  const id = dao.trim();
  return (
    <ToolFrame
      slug="dao-attestation"
      notes={
        <>
          <p>A Sputnik DAO is the attester. You propose a <code>FunctionCall</code> to <code>attest</code>; when the council approves, the DAO account calls the attestations contract itself, so the credential is signed by the DAO&apos;s own vote, not by any one member.</p>
          <p>On {DEFAULT_DAO || 'the deployment DAO'} the keeper is a reviewer that can only vote on function calls, and it approves a membership request about your own account in role member or contributor at once. Other roles, other schemas and revocations wait for a human vote.</p>
          <p>Any DAO can do this: create one with <code>attestra dao create</code>, fund its storage with <code>attestra dao fund</code>, then propose and vote here.</p>
        </>
      }
    >
      <div>
        <Label htmlFor="dao" hint="any Sputnik DAO v2">
          DAO
        </Label>
        <Input id="dao" className="font-mono text-[12.5px]" value={dao} onChange={(e) => setDao(e.target.value)} placeholder="guild.sputnik-v2.testnet" />
      </div>
      {id && <DaoCard dao={id} />}
      <ActionCard
        title="Ask for membership"
        subtitle="A proposal that the DAO attest your membership; you pay the bond"
        label="Submit proposal"
        disabled={!id || !w.accountId}
        action={async () => {
          const data = encoder.encode({ organization: id, role, since: Math.floor(Date.now() / 1000) });
          const r = await need(w.client).proposeDaoAttestation(id, { schemaUid: MEMBERSHIP, subject: w.accountId!, data, description: `Membership: ${w.accountId} as ${role}` });
          if (r.data) setPid(String(r.data.proposalId));
          return r;
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="role">Role</Label>
            <Select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.value} ({r.note})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Subject</Label>
            <p className="truncate py-2 font-mono text-[12.5px] text-soft">{w.accountId ?? 'sign in first'}</p>
          </div>
        </div>
      </ActionCard>
      <ActionCard
        title="Council review"
        subtitle="The keeper, the DAO's reviewer, checks the request against the DAO's rule and votes on chain"
        label="Ask the council"
        disabled={!id || !pid}
        busyNote="The keeper is voting; the DAO runs the attestation in the same transaction."
        action={() => councilReview(id, Number(pid))}
        render={(r) => <Verdict r={r} />}
      >
        <div>
          <Label htmlFor="pid">Proposal id</Label>
          <Input id="pid" value={pid} onChange={(e) => setPid(e.target.value)} className="sm:w-40" />
        </div>
      </ActionCard>
      <ActionCard title="Read the proposal" label="Read" disabled={!id || !pid} action={() => reader().getDaoProposal(id, Number(pid))} />
      <ActionCard
        title="Vote as a council member"
        subtitle="For a DAO you sit on; a deciding approval runs the DAO's call in the same transaction"
        label="Vote"
        disabled={!id || !pid || !w.accountId}
        action={() => need(w.client).voteDaoProposal(id, Number(pid), vote)}
      >
        <div className="sm:w-56">
          <Label htmlFor="vote">Vote</Label>
          <Select id="vote" value={vote} onChange={(e) => setVote(e.target.value as 'VoteApprove' | 'VoteReject')}>
            <option value="VoteApprove">Approve</option>
            <option value="VoteReject">Reject</option>
          </Select>
        </div>
      </ActionCard>
    </ToolFrame>
  );
}

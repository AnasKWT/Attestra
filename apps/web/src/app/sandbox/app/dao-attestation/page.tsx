'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DEPLOYMENT_DAOS, KNOWN_SCHEMAS, SchemaEncoder, daoApprovalsNeeded, knownSchemaUid } from 'attestra';
import { AccountLink, UidLink } from '@/components/explorer/Links';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select } from '@/components/ui/Field';
import { Badge, KeyValue, Panel, PanelHeader, Skeleton } from '@/components/ui/primitives';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { CONTRACTS, KEEPER_URL, NETWORK } from '@/lib/config';
import { formatTime } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

const DEFAULT_DAO = DEPLOYMENT_DAOS[NETWORK] ?? '';
const MEMBERSHIP = knownSchemaUid('membership');
const encoder = new SchemaEncoder(KNOWN_SCHEMAS.membership.definition);

interface Grant {
  delegate: string;
  schemas: string[] | null;
  expires_at: number;
  max_uses: number;
  uses: number;
  active: boolean;
}

function DaoCard({ dao }: { dao: string }) {
  const info = useAsync(async () => {
    const [config, policy, desk] = await Promise.all([
      reader().getDaoConfig(dao),
      reader().getDaoPolicy(dao),
      fetch(`${KEEPER_URL}/v1/dao`).then((r) => r.json() as Promise<{ delegate?: string | null }>).catch(() => ({ delegate: null })),
    ]);
    if (!policy.success || !policy.data) throw new Error(policy.error?.message ?? 'not a Sputnik DAO');
    // Every named role that can approve a function call, with the votes that decide one.
    const voters = policy.data.roles.flatMap((r) =>
      typeof r.kind === 'object' && 'Group' in r.kind && r.permissions.some((p) => ['*:*', 'call:*', '*:VoteApprove', 'call:VoteApprove'].includes(p))
        ? [{ name: r.name, members: r.kind.Group, approvals: daoApprovalsNeeded(policy.data!, r) }]
        : [],
    );
    const grant = desk.delegate ? await reader().view<Grant | null>(CONTRACTS.attestations, 'get_delegate', { authority: dao, delegate: desk.delegate }).catch(() => null) : null;
    return { purpose: config.data?.purpose ?? '', voters, grant, bond: Number(BigInt(policy.data.proposal_bond)) / 1e24 };
  }, [dao]);
  return (
    <Panel>
      <PanelHeader title="The DAO" subtitle="A Sputnik DAO v2; its policy says who may propose and vote" right={<Badge tone="brand">Sputnik DAO</Badge>} />
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
                  <span className="text-[12.5px] text-mute">{v.approvals === null ? 'token-weighted votes' : `${v.approvals} ${v.approvals === 1 ? 'vote decides' : 'votes decide'} any proposal`}</span>
                </span>
              </KeyValue>
            ))}
            <KeyValue label="Membership desk">
              {info.data.grant ? (
                <span className="flex flex-col gap-1.5">
                  <AccountLink id={info.data.grant.delegate} />
                  <span className="text-[12.5px] text-mute">
                    A delegate grant the council voted: the membership schema only, {info.data.grant.uses} of {info.data.grant.max_uses} uses, until {formatTime(info.data.grant.expires_at)}. It has no vote in the DAO.
                  </span>
                </span>
              ) : (
                <span className="text-mute">none: memberships go through the council</span>
              )}
            </KeyValue>
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
  const [councilRole, setCouncilRole] = useState('maintainer');
  const [pid, setPid] = useState('');
  const [vote, setVote] = useState<'VoteApprove' | 'VoteReject'>('VoteApprove');
  const id = dao.trim();
  return (
    <ToolFrame
      slug="dao-attestation"
      notes={
        <>
          <p>A Sputnik DAO is the attester, in two ways. <b>By vote</b>: anyone proposes a <code>FunctionCall</code> to <code>attest</code>, and when the council approves, the DAO account calls the attestations contract itself.</p>
          <p><b>Through a grant the council voted</b>: on {DEFAULT_DAO || 'the deployment DAO'} the council made the keeper an Attestra delegate of the DAO, limited on chain to the membership schema, a use limit and an expiry. The keeper issues with <code>attest_on_behalf</code>, so the attester is still the DAO, and its key cannot vote, spend or change the DAO.</p>
          <p>The desk admits an account that signed its own request and that another issuer already vouches for (one active attestation about it from someone else, such as a <Link className="text-accent hover:underline" href="/sandbox/app/private-check">private check</Link> or a <Link className="text-accent hover:underline" href="/sandbox/app/wallet-link">wallet link</Link>). Other roles go to the council.</p>
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
        title="Ask the membership desk"
        subtitle="You sign the request; the keeper issues it as the DAO under the council's grant"
        label="Request membership"
        disabled={!id || !w.accountId}
        busyNote="The desk checks your signature and who vouches for you, then issues."
        action={() => need(w.client).requestDaoMembership({ dao: id, role, signer: w.signer ?? undefined })}
        render={(d) => (
          <KeyValue label="Issued by the DAO">
            <UidLink uid={d.attestationUid} kind="attestations" />
          </KeyValue>
        )}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="role">Role</Label>
            <Select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">member</option>
              <option value="contributor">contributor</option>
            </Select>
          </div>
          <div>
            <Label>Subject</Label>
            <p className="truncate py-2 font-mono text-[12.5px] text-soft">{w.accountId ?? 'sign in first'}</p>
          </div>
        </div>
      </ActionCard>
      <ActionCard
        title="Propose to the council"
        subtitle="Any role; the DAO attests when the council approves. You pay the bond"
        label="Submit proposal"
        disabled={!id || !w.accountId || !councilRole.trim()}
        action={async () => {
          const data = encoder.encode({ organization: id, role: councilRole.trim(), since: Math.floor(Date.now() / 1000) });
          const r = await need(w.client).proposeDaoAttestation(id, { schemaUid: MEMBERSHIP, subject: w.accountId!, data, description: `Membership: ${w.accountId} as ${councilRole.trim()}` });
          if (r.data) setPid(String(r.data.proposalId));
          return r;
        }}
      >
        <div className="sm:w-64">
          <Label htmlFor="crole">Role</Label>
          <Input id="crole" value={councilRole} onChange={(e) => setCouncilRole(e.target.value)} />
        </div>
      </ActionCard>
      <ActionCard title="Read a proposal" label="Read" disabled={!id || !pid} action={() => reader().getDaoProposal(id, Number(pid))}>
        <div className="sm:w-40">
          <Label htmlFor="pid">Proposal id</Label>
          <Input id="pid" value={pid} onChange={(e) => setPid(e.target.value)} />
        </div>
      </ActionCard>
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

'use client';

import Link from 'next/link';
import { SchemaEncoder, isSputnikDao, type AttestationRecord } from 'attestra';
import { ExplorerShell } from '@/components/explorer/ExplorerShell';
import { AccountLink, UidLink } from '@/components/explorer/Links';
import { ProofPanel } from '@/components/explorer/ProofPanel';
import { Hash } from '@/components/ui/Copy';
import { Alert, Badge, KeyValue, Panel, PanelHeader, Skeleton, StatusBadge } from '@/components/ui/primitives';
import { indexer, reader } from '@/lib/client';
import { txUrl } from '@/lib/config';
import { formatTime } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

export function AttestationDetail({ uid }: { uid: string }) {
  const c = reader();
  const chain = useAsync(async () => {
    const a = await c.getAttestation(uid);
    if (!a.success || !a.data) throw new Error(a.error?.message ?? 'not found');
    const s = await c.getSchema(a.data.schema_uid);
    let decoded: Record<string, unknown> | null = null;
    try {
      decoded = s.data ? new SchemaEncoder(s.data.definition).decode(a.data.data) : null;
    } catch {
      decoded = null;
    }
    const cred = await c.getCredential(uid);
    return { a: a.data, schema: s.data ?? null, decoded, credential: cred.data ?? null };
  }, [uid]);
  const idx = useAsync(() => indexer.getAttestation(uid), [uid]);

  return (
    <ExplorerShell title="Attestation" intro={<Hash value={uid} full className="text-[13px]" />}>
      {chain.error && <Alert tone="bad" title="Not found on chain">{chain.error}</Alert>}
      {chain.loading && <Skeleton className="h-64 w-full" />}
      {chain.data && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="space-y-6">
            <Panel>
              <PanelHeader title="Record" subtitle="Read live from the attestations contract" right={<StatusBadge status={chain.data.a.status} />} />
              <dl className="px-5 py-2">
                <KeyValue label="Schema">
                  <UidLink uid={chain.data.a.schema_uid} kind="schemas" />
                  {chain.data.schema && <span className="ml-2 font-mono text-[11.5px] text-mute">{chain.data.schema.definition.slice(0, 60)}{chain.data.schema.definition.length > 60 ? '...' : ''}</span>}
                </KeyValue>
                <KeyValue label="Attester">
                  <AccountLink id={chain.data.a.attester} />
                  {isSputnikDao(chain.data.a.attester) && <Badge tone="brand" className="ml-2">Sputnik DAO</Badge>}
                </KeyValue>
                <KeyValue label="Subject"><AccountLink id={chain.data.a.subject} /></KeyValue>
                <KeyValue label="Issued">{formatTime(chain.data.a.created_at)}</KeyValue>
                <KeyValue label="Expires">{chain.data.a.expiration_time ? formatTime(chain.data.a.expiration_time) : 'never'}</KeyValue>
                {chain.data.a.revoke_at > 0 && <KeyValue label="Scheduled revocation">{formatTime(chain.data.a.revoke_at)}</KeyValue>}
                {chain.data.a.revoked && <KeyValue label="Revoked at">{formatTime(chain.data.a.revocation_time)}</KeyValue>}
                <KeyValue label="Nonce" mono>{chain.data.a.nonce}</KeyValue>
                {chain.data.a.ref_uid && <KeyValue label="References"><UidLink uid={chain.data.a.ref_uid} kind="attestations" /></KeyValue>}
                {idx.data?.tx_hash && <KeyValue label="Transaction"><Hash value={idx.data.tx_hash} external={txUrl(idx.data.tx_hash)} /></KeyValue>}
                {idx.data?.revoke_tx_hash && <KeyValue label="Revocation tx"><Hash value={idx.data.revoke_tx_hash} external={txUrl(idx.data.revoke_tx_hash)} /></KeyValue>}
              </dl>
            </Panel>
            <Panel>
              <PanelHeader title="Data" subtitle="Borsh bytes decoded with the schema definition" />
              <div className="p-5">
                {chain.data.decoded ? (
                  <div className="overflow-hidden rounded-xl border border-line">
                    <table className="w-full text-left text-[13px]">
                      <tbody>
                        {Object.entries(chain.data.decoded).map(([k, v]) => (
                          <tr key={k} className="border-b border-line last:border-0">
                            <td className="w-1/3 bg-panel-2 px-3 py-2 font-mono text-[12px] text-mute">{k}</td>
                            <td className="break-all px-3 py-2 font-mono text-[12.5px] text-fg">{Array.isArray(v) ? v.join(', ') : String(v)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-[13px] text-mute">Raw (base64): <span className="break-all font-mono text-fg">{chain.data.a.data || 'empty'}</span></p>
                )}
              </div>
            </Panel>
          </div>
          <div className="space-y-6">
            {isSputnikDao(chain.data.a.attester) && <DaoVotePanel a={chain.data.a} />}
            <ProofPanel uid={uid} revoked={chain.data.a.revoked} />
            <Panel>
              <PanelHeader title="Credential" subtitle="Non-transferable NEP-171 token linked to this attestation" />
              <div className="p-5 text-[13.5px]">
                {chain.data.credential ? (
                  <div className="space-y-2">
                    <Badge tone="ok">minted to {chain.data.credential.owner_id}</Badge>
                    <p className="text-mute">It burns automatically when the attestation is revoked.</p>
                  </div>
                ) : (
                  <p className="text-mute">
                    No credential yet. The attester or the subject can mint one from the <Link className="text-accent hover:underline" href="/sandbox/app/nft-credential">credential tool</Link>.
                  </p>
                )}
              </div>
            </Panel>
          </div>
        </div>
      )}
    </ExplorerShell>
  );
}

/** The DAO proposal whose approval issued a DAO's attestation: who asked, who voted, and what it said. */
function DaoVotePanel({ a }: { a: AttestationRecord }) {
  const vote = useAsync(async () => {
    const r = await reader().getDaoProposals(a.attester, { limit: 100 });
    if (!r.success || !r.data) throw new Error(r.error?.message ?? 'the DAO did not answer');
    const proposal = r.data.find((p) => p.status === 'Approved' && p.call?.method === 'attest' && p.call.schemaUid === a.schema_uid && p.call.subject === a.subject && p.call.data === a.data) ?? null;
    if (proposal) return { proposal, delegate: null };
    // Not by a vote of its own: issued by a delegate under a grant the DAO's council voted.
    const ev = await indexer.listEvents({ uid: a.uid, event: 'attestation_created', limit: 1 }).catch(() => null);
    const actor = ev?.data[0]?.data?.actor as string | undefined;
    if (!actor || actor === a.attester) return { proposal: null, delegate: null };
    const grant = await reader().view<{ schemas: string[] | null; max_uses: number; uses: number; expires_at: number } | null>(reader().contracts.attestations, 'get_delegate', { authority: a.attester, delegate: actor }).catch(() => null);
    const grantProposal = r.data.find((p) => p.status === 'Approved' && grantsTo(p.kind, actor)) ?? null;
    return { proposal: null, delegate: { actor, grant, grantProposal } };
  }, [a.attester, a.schema_uid, a.subject, a.data, a.uid]);
  return (
    <Panel>
      <PanelHeader title="DAO decision" subtitle="The Sputnik DAO vote, or the grant its council voted, that issued this attestation" />
      <div className="p-5 text-[13.5px]">
        {vote.loading && <Skeleton className="h-20" />}
        {vote.error && <p className="text-mute">{vote.error}</p>}
        {!vote.loading && !vote.error && vote.data && !vote.data.proposal && !vote.data.delegate && <p className="text-mute">No approved proposal among the DAO&apos;s latest 100 matches this attestation.</p>}
        {vote.data?.delegate && (
          <dl>
            <KeyValue label="Issued by"><AccountLink id={vote.data.delegate.actor} /></KeyValue>
            <KeyValue label="Under">
              <span className="text-soft">
                a delegate grant of the DAO{vote.data.delegate.grantProposal ? `, voted in proposal #${vote.data.delegate.grantProposal.id}` : ''}
                {vote.data.delegate.grant ? `: ${vote.data.delegate.grant.schemas?.length ?? 'any'} schema(s), ${vote.data.delegate.grant.uses} of ${vote.data.delegate.grant.max_uses || 'unlimited'} uses` : ' (since withdrawn)'}
              </span>
            </KeyValue>
            {vote.data.delegate.grantProposal && (
              <KeyValue label="Grant approved by">
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  {Object.keys(vote.data.delegate.grantProposal.votes).map((who) => (
                    <AccountLink key={who} id={who} />
                  ))}
                </span>
              </KeyValue>
            )}
          </dl>
        )}
        {vote.data?.proposal && (
          <dl>
            <KeyValue label="Proposal" mono>#{vote.data.proposal.id}</KeyValue>
            <KeyValue label="Proposed by"><AccountLink id={vote.data.proposal.proposer} /></KeyValue>
            <KeyValue label="Description">{vote.data.proposal.description}</KeyValue>
            <KeyValue label="Votes">
              <span className="flex flex-col gap-1.5">
                {Object.entries(vote.data.proposal.votes).map(([who, v]) => (
                  <span key={who} className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <AccountLink id={who} />
                    <Badge tone={v === 'Approve' ? 'ok' : 'bad'}>{v}</Badge>
                  </span>
                ))}
              </span>
            </KeyValue>
            <KeyValue label="Proposed">{formatTime(Math.floor(Number(BigInt(vote.data.proposal.submission_time) / 1_000_000_000n)))}</KeyValue>
          </dl>
        )}
      </div>
    </Panel>
  );
}

/** Whether a proposal kind is an `add_delegate` call naming `delegate`. */
function grantsTo(kind: unknown, delegate: string): boolean {
  const fc = (kind as { FunctionCall?: { actions?: Array<{ method_name?: string; args?: string }> } })?.FunctionCall;
  return (fc?.actions ?? []).some((a) => {
    if (a.method_name !== 'add_delegate' || !a.args) return false;
    try {
      return (JSON.parse(atob(a.args)) as { delegate?: string }).delegate === delegate;
    } catch {
      return false;
    }
  });
}

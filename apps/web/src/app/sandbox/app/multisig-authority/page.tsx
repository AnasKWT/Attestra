'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { SchemaPicker, SchemaValues } from '@/components/sandbox/SchemaFields';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';

export default function Multisig() {
  const w = useWallet();
  const [members, setMembers] = useState('');
  const [k, setK] = useState('2');
  const [meta, setMeta] = useState('Credentials committee');
  const [ms, setMs] = useState('');
  const [schema, setSchema] = useState('');
  const [definition, setDefinition] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [data, setData] = useState<string | null>(null);
  const [pid, setPid] = useState('');
  return (
    <ToolFrame
      slug="multisig-authority"
      notes={
        <>
          <p>A multisig authority is an identity like <code>ms-1.attestations...</code> that only the contract can act as. Members propose; when <i>k</i> approve, the action executes with the multisig as the attester.</p>
          <p>Include yourself in the members to propose.</p>
        </>
      }
    >
      <ActionCard title="Create" label="Create multisig" disabled={!members} action={async () => { const r = await need(w.client).createMultisigAuthority({ members: members.split(',').map((m) => m.trim()).filter(Boolean), threshold: Number(k), metadata: meta }); if (r.data) setMs(r.data.multisigId); return r; }}>
        <div>
          <Label htmlFor="mem" hint="comma-separated, 2 to 10">Members</Label>
          <Input id="mem" value={members} onChange={(e) => setMembers(e.target.value)} placeholder={`${w.accountId ?? 'alice.testnet'}, bob.testnet, carol.testnet`} />
        </div>
        <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
          <div>
            <Label htmlFor="k">Threshold</Label>
            <Input id="k" type="number" min={1} value={k} onChange={(e) => setK(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="meta">Description</Label>
            <Input id="meta" value={meta} onChange={(e) => setMeta(e.target.value)} />
          </div>
        </div>
      </ActionCard>
      <ActionCard title="Propose an attestation" label="Propose" disabled={!ms || !data || !subject} action={async () => { const r = await need(w.client).proposeMultisig(ms, { type: 'attest', schema_uid: schema, subject, data: data! }); if (r.data) setPid(String(r.data.proposalId)); return r; }}>
        <div>
          <Label htmlFor="ms">Multisig id</Label>
          <Input id="ms" className="font-mono text-[12.5px]" value={ms} onChange={(e) => setMs(e.target.value)} />
        </div>
        <SchemaPicker value={schema} onChange={setSchema} onDefinition={setDefinition} />
        <div>
          <Label htmlFor="sub">Subject</Label>
          <Input id="sub" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        {definition && <SchemaValues definition={definition} onEncoded={(d) => setData(d)} />}
      </ActionCard>
      <ActionCard title="Approve" subtitle="Signed in as another member; executes at the threshold" label="Approve" disabled={!pid} action={() => need(w.client).approveMultisig(Number(pid))}>
        <div>
          <Label htmlFor="pid">Proposal id</Label>
          <Input id="pid" value={pid} onChange={(e) => setPid(e.target.value)} className="sm:w-40" />
        </div>
      </ActionCard>
      <ActionCard title="Execute" subtitle="Any member; execute runs a proposal that already has enough approvals (a 1-of-n multisig)" label="Execute" disabled={!pid} action={() => need(w.client).executeMultisig(Number(pid))} />
      <ActionCard title="Cancel" subtitle="The proposer withdraws an open proposal" label="Cancel proposal" disabled={!pid} action={() => need(w.client).cancelMultisig(Number(pid))} />
      <ActionCard title="Read" label="Read proposal and multisig" disabled={!pid && !ms} action={async () => ({ success: true, data: { proposal: pid ? (await reader().getProposal(Number(pid))).data : null, multisig: ms ? (await reader().getMultisig(ms)).data : null } })} />
    </ToolFrame>
  );
}

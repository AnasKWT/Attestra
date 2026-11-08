'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ActionCard, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select, Textarea } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';

function Tool() {
  const w = useWallet();
  const params = useSearchParams();
  const [agent, setAgent] = useState(params.get('agent') ?? '');
  const [name, setName] = useState('Research agent');
  const [model, setModel] = useState('zai-org/GLM-5.1');
  const [caps, setCaps] = useState('verify_claims, summarize');
  const [endpoint, setEndpoint] = useState('');
  const [desc, setDesc] = useState('');
  const [days, setDays] = useState('7');
  const [uses, setUses] = useState('20');
  const [score, setScore] = useState('5');
  const [comment, setComment] = useState('');
  const [job, setJob] = useState('');
  return (
    <ToolFrame
      slug="agents"
      notes={
        <>
          <p><b>Identity</b>: the owner attests an agent identity (owner, model, capabilities, endpoint) about the agent account.</p>
          <p><b>Delegation</b>: the owner lets the agent attest for them, limited to a number of uses and an expiry, enforced by the contract. For keys, give the agent a function-call key that can only call the attestations contract.</p>
          <p><b>Reputation</b>: anyone who hired the agent leaves a 1 to 5 review. Profiles average the active reviews.</p>
          <p>See every agent on the <Link className="text-accent hover:underline" href="/agents">agents page</Link>.</p>
        </>
      }
    >
      <div>
        <Label htmlFor="ag">Agent account</Label>
        <Input id="ag" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="research-agent.testnet" />
      </div>
      <ActionCard title="Owner: register the agent" label="Attest identity" disabled={!agent || !name} action={() => need(w.client).registerAgent({ agent: agent.trim(), name, model, capabilities: caps.split(',').map((c) => c.trim()).filter(Boolean), endpoint, description: desc })} render={(d) => <UidResult uid={d.attestationUid} kind="attestations" />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><Label htmlFor="n">Name</Label><Input id="n" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><Label htmlFor="m">Model</Label><Input id="m" value={model} onChange={(e) => setModel(e.target.value)} /></div>
          <div><Label htmlFor="c" hint="comma-separated">Capabilities</Label><Input id="c" value={caps} onChange={(e) => setCaps(e.target.value)} /></div>
          <div><Label htmlFor="e">Endpoint</Label><Input id="e" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://..." /></div>
        </div>
        <div><Label htmlFor="d">Description</Label><Textarea id="d" rows={2} className="font-sans text-[14px]" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
      </ActionCard>
      <ActionCard title="Owner: delegate to the agent" label="Delegate" disabled={!agent} action={() => need(w.client).delegateToAgent(agent.trim(), { expiresAt: Math.floor(Date.now() / 1000) + Number(days) * 86400, maxUses: Number(uses) })}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><Label htmlFor="days">Days</Label><Input id="days" type="number" value={days} onChange={(e) => setDays(e.target.value)} /></div>
          <div><Label htmlFor="uses">Max attestations</Label><Input id="uses" type="number" value={uses} onChange={(e) => setUses(e.target.value)} /></div>
        </div>
      </ActionCard>
      <ActionCard title="Client: review the agent" label="Leave review" disabled={!agent} action={() => need(w.client).rateAgent({ agent: agent.trim(), score: Number(score), comment, jobRef: job })} render={(d) => <UidResult uid={d.attestationUid} kind="attestations" />}>
        <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
          <div>
            <Label htmlFor="sc">Score</Label>
            <Select id="sc" value={score} onChange={(e) => setScore(e.target.value)}>{[5, 4, 3, 2, 1].map((n) => <option key={n}>{n}</option>)}</Select>
          </div>
          <div><Label htmlFor="j">Job</Label><Input id="j" value={job} onChange={(e) => setJob(e.target.value)} placeholder="what you hired it for" /></div>
        </div>
        <div><Label htmlFor="cm">Comment</Label><Input id="cm" value={comment} onChange={(e) => setComment(e.target.value)} /></div>
      </ActionCard>
      {agent && <Link href={`/agents/${encodeURIComponent(agent.trim())}`} className="inline-block text-[13.5px] text-accent hover:underline">Open the agent profile</Link>}
    </ToolFrame>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Tool />
    </Suspense>
  );
}

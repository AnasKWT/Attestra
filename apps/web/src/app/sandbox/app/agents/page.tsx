'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ActionCard, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select, Textarea } from '@/components/ui/Field';
import { Button } from '@/components/ui/primitives';
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
  const [lookup, setLookup] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });

  /** Fills job_ref with the signed-in account's newest payment to the agent (or its verified owner). */
  async function fillFromPayment() {
    if (!w.client || !w.accountId) return setLookup({ busy: false, note: 'Sign in to look up your payments.' });
    setLookup({ busy: true, note: null });
    const r = await w.client.recentPaymentsTo(agent.trim());
    const latest = r.success ? r.data?.[0] : undefined;
    if (latest) {
      setJob(latest.txHash);
      const how = latest.payment.method === 'transfer' ? 'NEAR transfer' : latest.payment.relayer ? 'x402 payment' : latest.payment.method;
      return setLookup({ busy: false, note: `Filled with your ${how} to ${latest.payment.payee} in block ${latest.blockHeight}.` });
    }
    setLookup({ busy: false, note: r.success ? `No recent payment from ${w.accountId} to this agent in NEAR or the payment token.` : (r.error?.message ?? 'The lookup failed.') });
  }
  return (
    <ToolFrame
      slug="agents"
      notes={
        <>
          <p><b>Identity</b>: the owner attests an agent identity (owner, model, capabilities, endpoint) about the agent account. It is verified only when it is signed by the agent account itself or by an account the agent is a sub-account of (bot.alice.testnet by alice.testnet); any other attester leaves it unverified.</p>
          <p><b>Delegation</b>: the owner lets the agent attest for them, limited to a number of uses and an expiry, enforced by the contract. For keys, give the agent a function-call key that can only call the attestations contract.</p>
          <p><b>Reputation</b>: anyone who hired the agent leaves a 1 to 5 review. Profiles count the newest review of each reviewer and skip reviews by the agent, its owner and their sub-accounts.</p>
          <p><b>Paid reviews</b>: put the hash of your payment to the agent in job_ref (a NEAR transfer, an ft_transfer of the payment token, or an x402 payment). Profiles read that transaction from the chain; the agent is trusted with a verified identity and paid reviews averaging at least 3.5.</p>
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
      <ActionCard
        title="Client: review the agent"
        subtitle="job_ref should be the transaction hash of your payment to the agent; only then does the review count as paid"
        label="Leave review"
        disabled={!agent}
        action={() => need(w.client).rateAgent({ agent: agent.trim(), score: Number(score), comment, jobRef: job.trim() })}
        render={(d) => <UidResult uid={d.attestationUid} kind="attestations" />}
      >
        <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
          <div>
            <Label htmlFor="sc">Score</Label>
            <Select id="sc" value={score} onChange={(e) => setScore(e.target.value)}>{[5, 4, 3, 2, 1].map((n) => <option key={n}>{n}</option>)}</Select>
          </div>
          <div>
            <Label htmlFor="j" hint="job_ref: your payment's transaction hash">Payment</Label>
            <div className="flex gap-2">
              <Input id="j" className="font-mono text-[13px]" value={job} onChange={(e) => setJob(e.target.value)} placeholder="transaction hash" />
              <Button type="button" variant="secondary" size="md" className="shrink-0" disabled={!agent || lookup.busy} onClick={fillFromPayment}>
                {lookup.busy ? 'Looking...' : 'Use my latest payment'}
              </Button>
            </div>
            {lookup.note && <p className="mt-1.5 text-[12.5px] text-mute">{lookup.note}</p>}
          </div>
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

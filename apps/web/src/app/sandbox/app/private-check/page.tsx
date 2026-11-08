'use client';

import { ExternalLink, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ActionCard, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select, Textarea } from '@/components/ui/Field';
import { Badge, Panel, PanelHeader } from '@/components/ui/primitives';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { CONTRACTS } from '@/lib/config';
import { useAsync } from '@/lib/useFetch';

interface Rule {
  id: string;
  claim: string;
  enabled: boolean;
}

export default function PrivateCheck() {
  const w = useWallet();
  const rules = useAsync(() => reader().view<Rule[]>(CONTRACTS.verdicts, 'get_rules'), []);
  const [rule, setRule] = useState('age_over_18');
  const [subject, setSubject] = useState('');
  const [evidence, setEvidence] = useState('');
  const [github, setGithub] = useState('');
  const isGithub = rule.startsWith('github');
  return (
    <ToolFrame
      slug="private-check"
      notes={
        <>
          <p><b>In your browser</b>, the evidence is encrypted to the attested key of a NEAR AI Cloud verifiable model (X25519 + XChaCha20-Poly1305). Attestra, the enclave and the NEAR AI gateway cannot read it.</p>
          <p><b>In an OutLayer enclave</b>, a program whose signing key is bound to its build adds the rule, calls the model, checks the model&apos;s response signature, and signs a verdict. For GitHub rules it fetches the data itself, so the claim cannot be faked.</p>
          <p><b>On chain</b>, <code>{CONTRACTS.verdicts}</code> checks both signatures (the enclave&apos;s and the model&apos;s) and attests a pass. Only the SHA-256 of the request is stored; the evidence is never stored anywhere.</p>
          <p>Limits: a model can be misled by text in the evidence that pretends to be instructions; rules return a strict yes or no to keep this small.</p>
        </>
      }
      aside={
        <Panel>
          <PanelHeader icon={<ShieldCheck className="size-4" />} title="Verify the model yourself" />
          <div className="space-y-2 px-5 py-4 text-[13px] text-soft">
            <p>Every answer has a NEAR AI signature you can check at the NEAR AI verification center.</p>
            <a href="https://cloud.near.ai/verify" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              cloud.near.ai/verify <ExternalLink className="size-3.5" />
            </a>
          </div>
        </Panel>
      }
    >
      <ActionCard
        icon={<Lock className="size-4" />}
        title="Check a private fact"
        subtitle="A pass becomes an attestation under the private AI check schema"
        label="Encrypt and check"
        disabled={!subject || (!evidence && !isGithub) || (isGithub && !github)}
        action={() => need(w.client).requestPrivateCheck({ ruleId: rule, subject: subject.trim(), evidence, github: github || undefined })}
        render={(d) => (
          <div className="space-y-3 text-[13px]">
            {d.outcome.status === 'created' ? <UidResult uid={d.outcome.uid} kind="attestations" /> : <Badge tone="warn">the check did not pass: nothing was attested</Badge>}
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-line bg-panel p-2.5"><p className="text-mute">Model</p><p className="font-mono text-[12px] text-fg">{String(d.verdict.model ?? '')}</p></div>
              <div className="rounded-lg border border-line bg-panel p-2.5"><p className="text-mute">Evidence hash</p><p className="break-all font-mono text-[11.5px] text-fg">{String(d.verdict.evidence_hash ?? '')}</p></div>
            </div>
            <a href={d.verifyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">Check the NEAR AI signature <ExternalLink className="size-3.5" /></a>
          </div>
        )}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="rule">Rule</Label>
            <Select id="rule" value={rule} onChange={(e) => setRule(e.target.value)}>
              {(rules.data ?? [{ id: 'age_over_18', claim: 'is at least 18 years old', enabled: true }]).filter((r) => r.enabled).map((r) => (
                <option key={r.id} value={r.id}>{r.claim}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="sub">About whom</Label>
            <Input id="sub" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={w.accountId ?? 'bob.testnet'} />
          </div>
        </div>
        {isGithub ? (
          <div>
            <Label htmlFor="gh" hint="the enclave reads GitHub itself">GitHub login</Label>
            <Input id="gh" value={github} onChange={(e) => setGithub(e.target.value)} placeholder="octocat" />
          </div>
        ) : (
          <div>
            <Label htmlFor="ev" hint="encrypted before it leaves this page">Evidence</Label>
            <Textarea id="ev" rows={5} className="font-sans text-[14px]" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Paste the relevant text of a document, for example the date of birth line of an ID or a payslip summary." />
          </div>
        )}
      </ActionCard>
    </ToolFrame>
  );
}

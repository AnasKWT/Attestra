'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { CheckerModeBadge } from '@/components/marketing/CheckerMode';
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
  const subject = w.accountId ?? '';
  const [evidence, setEvidence] = useState('');
  const [github, setGithub] = useState('');
  const isGithub = rule.startsWith('github');
  return (
    <ToolFrame
      slug="private-check"
      notes={
        <>
          <p><b>You ask for it</b>: a check is always about your own account, and your key signs the request (NEP-413) naming the rule and the hash of your encrypted evidence. The checker verifies that signature, and that the key is yours on chain, before it signs anything, so nobody can attest a fact about an account that did not ask.</p>
          <p><b>In your browser</b>, the evidence is encrypted to the attested key of a NEAR AI Cloud verifiable model (X25519 + XChaCha20-Poly1305). Attestra, the checker and the NEAR AI gateway cannot read it.</p>
          <p><b>In the checker</b>, the rule is added, the model is called, the model&apos;s response signature is checked and a verdict is signed. For GitHub rules the checker first checks that the login is yours (a public gist <code>attestra.txt</code> with the line <code>attestra:&lt;your account&gt;</code>), then fetches the data itself, so the claim cannot be faked; the login is never stored on chain. The checker runs in one of two modes:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li><b>OutLayer</b>: a component inside an OutLayer TEE, whose signing key is bound to its build.</li>
            <li><b>Local</b>: inside the Attestra agent, signing with a bootstrap key its operator holds.</li>
          </ul>
          <p className="flex flex-wrap items-center gap-2">Right now: <CheckerModeBadge /></p>
          <p><b>On chain</b>, <code>{CONTRACTS.verdicts}</code> checks both signatures (the checker&apos;s and the model&apos;s) and attests a pass. Only the SHA-256 of the request is stored; the evidence is never stored anywhere.</p>
          <p>Limits: a model can be misled by text in the evidence that pretends to be instructions; rules return a strict yes or no to keep this small.</p>
        </>
      }
      aside={
        <Panel>
          <PanelHeader title="Verify the model yourself" />
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
        title="Check a private fact"
        subtitle="A pass becomes an attestation under the private AI check schema"
        label="Encrypt and check"
        busyNote="Running in the TEE. This can take a few minutes when the OutLayer queue is busy."
        disabled={!subject || (!evidence && !isGithub) || (isGithub && !github)}
        action={() => need(w.client).requestPrivateCheck({ ruleId: rule, subject, evidence, github: github || undefined, signer: w.signer ?? undefined })}
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
            <Label hint="you sign the request">About whom</Label>
            <p className="truncate py-2 font-mono text-[12.5px] text-soft">{subject || 'sign in first'}</p>
          </div>
        </div>
        {isGithub ? (
          <div className="space-y-2">
            <Label htmlFor="gh" hint="the checker reads GitHub itself">GitHub login</Label>
            <Input id="gh" value={github} onChange={(e) => setGithub(e.target.value)} placeholder="octocat" />
            <p className="text-[12.5px] text-mute">
              First publish a public gist from that login with a file <code className="font-mono">attestra.txt</code> containing the line{' '}
              <code className="break-all font-mono">attestra:{subject || '<your account>'}</code>.{' '}
              <a className="text-accent hover:underline" href="https://gist.github.com/" target="_blank" rel="noreferrer">gist.github.com</a>
            </p>
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

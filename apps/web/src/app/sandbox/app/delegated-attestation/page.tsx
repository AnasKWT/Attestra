'use client';

import { useState } from 'react';
import type { SignedRequest } from 'attestra';
import { ActionCard, Result, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { SchemaPicker, SchemaValues } from '@/components/sandbox/SchemaFields';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { Button, Panel, PanelHeader } from '@/components/ui/primitives';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';

export default function DelegatedAttestation() {
  const w = useWallet();
  const [schema, setSchema] = useState('');
  const [definition, setDefinition] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [data, setData] = useState<string | null>(null);
  const [req, setReq] = useState<SignedRequest | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [delegate, setDelegate] = useState('');
  const [authority, setAuthority] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const sign = async () => {
    if (!w.signer || !w.accountId) throw new Error('sign in first');
    const r = await need(w.client).signDelegatedAttestation({ attester: w.accountId, schemaUid: schema, subject, data: data! }, w.signer);
    if (r.success && r.data) {
      setReq(r.data);
      const keys = await reader().getSignerKeys(w.accountId);
      setRegistered(Boolean(keys.data?.keys.includes(r.data.public_key)) || /^[0-9a-f]{64}$/.test(w.accountId));
    }
    return r;
  };

  return (
    <ToolFrame
      slug="delegated-attestation"
      notes={
        <>
          <p><b>Signed requests:</b> you sign an attestation off chain with NEP-413; the relayer submits it and pays the gas. The contract checks the signature, a deadline and a one-time nonce, so a request cannot be replayed.</p>
          <p>The signing key must be registered once with <code>add_signer_key</code> (passkey accounts need nothing: their account id is their key).</p>
          <p><b>On-chain delegates:</b> grant an account (an employee, a bot, an agent) the right to attest for you, limited to schemas, a number of uses and an expiry.</p>
        </>
      }
    >
      <ActionCard title="1. Sign a request off chain" subtitle="No transaction: your wallet or passkey signs a message" label="Sign" disabled={!definition || !data || !subject || !w.signer} action={sign} render={() => <p className="text-[13px] text-fg">Signed. Next: submit it below.</p>}>
        <SchemaPicker value={schema} onChange={setSchema} onDefinition={setDefinition} />
        <div>
          <Label htmlFor="subj">Subject</Label>
          <Input id="subj" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="bob.testnet" />
        </div>
        {definition && <SchemaValues definition={definition} onEncoded={(d) => setData(d)} />}
      </ActionCard>

      {req && (
        <Panel label="2. Submit">
          <PanelHeader title="2. Submit" subtitle="Through the relayer (gasless) or yourself" />
          <div className="space-y-4 p-5">
            <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-panel-2 p-3 font-mono text-[11.5px] text-fg">{JSON.stringify(req, null, 2)}</pre>
            {registered === false && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px]">
                <span className="flex-1 text-fg">This key is not registered as a signer key yet.</span>
                <Button size="sm" variant="secondary" onClick={async () => { const r = await need(w.client).addSignerKey(req.public_key); setMsg(r.success ? 'Key registered.' : r.error?.message ?? ''); if (r.success) setRegistered(true); }}>
                  Register key (one transaction)
                </Button>
              </div>
            )}
            {msg && <p className="text-[12.5px] text-soft">{msg}</p>}
            <div className="flex flex-wrap gap-3">
              <SubmitButton label="Submit through the relayer" run={() => reader().relaySigned(req)} />
              <SubmitButton label="Submit myself" variant="secondary" run={() => need(w.client).submitSigned(req)} />
            </div>
          </div>
        </Panel>
      )}

      <ActionCard title="On-chain delegate" subtitle="Let another account attest for you" label="Add delegate" disabled={!delegate} action={() => need(w.client).addDelegate(delegate.trim(), { schemas: schema && /^[0-9a-f]{64}$/i.test(schema) ? [schema] : undefined, maxUses: 10, canRevoke: true, label: 'sandbox delegate' })}>
        <div>
          <Label htmlFor="del" hint="scope: the schema above, 10 uses, may revoke">Delegate account</Label>
          <Input id="del" value={delegate} onChange={(e) => setDelegate(e.target.value)} placeholder="assistant.testnet" />
        </div>
      </ActionCard>

      <ActionCard title="Attest as a delegate" subtitle="Signed in as the delegate, attest for the authority" label="Attest on behalf" disabled={!authority || !data || !subject} action={() => need(w.client).attestOnBehalf({ authority: authority.trim(), schemaUid: schema, subject, data: data! })} render={(d) => <UidResult uid={d.attestationUid} kind="attestations" />}>
        <div>
          <Label htmlFor="auth">Authority you act for</Label>
          <Input id="auth" value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="acme.testnet" />
        </div>
      </ActionCard>
    </ToolFrame>
  );
}

function SubmitButton({ label, run, variant = 'primary' }: { label: string; run: () => Promise<import('attestra').ServiceResponse<{ uid: string; status: string }>>; variant?: 'primary' | 'secondary' }) {
  const [res, setRes] = useState<import('attestra').ServiceResponse<{ uid: string; status: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="min-w-0 flex-1">
      <Button variant={variant} disabled={busy} onClick={async () => { setBusy(true); setRes(await run()); setBusy(false); }}>{busy ? 'Submitting' : label}</Button>
      {res && <div className="mt-3"><Result res={res} render={(d) => <UidResult uid={d.uid} kind="attestations" />} /></div>}
    </div>
  );
}

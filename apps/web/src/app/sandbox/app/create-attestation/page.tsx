'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ActionCard, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { SchemaPicker, SchemaValues } from '@/components/sandbox/SchemaFields';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';

function Tool() {
  const w = useWallet();
  const params = useSearchParams();
  const [schema, setSchema] = useState(params.get('schema') ?? '');
  const [definition, setDefinition] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [data, setData] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expires, setExpires] = useState('');
  return (
    <ToolFrame
      slug="create-attestation"
      notes={
        <>
          <p>The subject can be a NEAR account or a CAIP-10 id on another chain, for example <code>eip155:1:0xab...</code> or <code>solana:5eykt4...:9Wz...</code>.</p>
          <p>Values are Borsh-encoded with the schema definition by the SDK&apos;s <code>SchemaEncoder</code>.</p>
          <p>If the schema has a resolver, the attestation waits as pending until the resolver answers; a refusal removes it and refunds its storage.</p>
        </>
      }
    >
      <ActionCard
        title="Attestation"
        label="Attest"
        disabled={!definition || !data || !subject}
        action={() => need(w.client).createAttestation({ schemaUid: schema, subject: subject.trim(), data: data!, expirationTime: expires ? Math.floor(new Date(expires).getTime() / 1000) : undefined })}
        render={(d) => <UidResult uid={d.attestationUid} kind="attestations" />}
      >
        <SchemaPicker value={schema} onChange={setSchema} onDefinition={setDefinition} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="subject">Subject</Label>
            <Input id="subject" placeholder="bob.testnet or eip155:1:0x..." value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="exp" hint="optional">Expires</Label>
            <Input id="exp" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </div>
        </div>
        {definition && <SchemaValues definition={definition} onEncoded={(d, e) => (setData(d), setErr(e))} />}
        {err && definition && <p className="text-[12.5px] text-amber-600 dark:text-amber-400">{err}</p>}
      </ActionCard>
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

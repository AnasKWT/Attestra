'use client';

import { useState } from 'react';
import { computeSchemaUid } from '@attestra/sdk';
import { ActionCard, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Label, Textarea, Toggle } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';

const SAMPLE = Array.from({ length: 60 }, (_, i) => `${['string', 'u64', 'bool', 'bytes32', 'account_id'][i % 5]} field_${i + 1}`).join(', ');

export default function LargeSchema() {
  const w = useWallet();
  const [def, setDef] = useState(SAMPLE);
  const [hash, setHash] = useState('');
  const [revocable, setRevocable] = useState(true);
  return (
    <ToolFrame
      slug="file-schema"
      notes={
        <>
          <p>Inline definitions are limited to 16 KB. Larger ones are stored once as a content-addressed blob (up to 256 KB), paid from your NEP-145 storage balance, then registered by hash.</p>
          <p>The schema UID is the same as registering the same text inline: <code>{computeSchemaUid(def, null, revocable).slice(0, 18)}...</code></p>
        </>
      }
    >
      <ActionCard title="1. Store the definition" subtitle={`${new TextEncoder().encode(def).length.toLocaleString()} bytes`} label="Store blob" disabled={!def} action={async () => { const r = await need(w.client).storeSchemaBlob(def); if (r.data) setHash(r.data.blobHash); return r; }}>
        <div>
          <Label htmlFor="d">Definition</Label>
          <Textarea id="d" rows={8} value={def} onChange={(e) => setDef(e.target.value)} />
        </div>
      </ActionCard>
      <ActionCard title="2. Register from the blob" label="Register schema" disabled={!hash} action={() => need(w.client).registerSchemaFromBlob({ blobHash: hash, revocable })} render={(d) => <UidResult uid={d.schemaUid} kind="schemas" />}>
        <p className="break-all font-mono text-[12px] text-soft">Blob: {hash || 'store it first'}</p>
        <Toggle checked={revocable} onChange={setRevocable} label="Revocable" />
      </ActionCard>
    </ToolFrame>
  );
}

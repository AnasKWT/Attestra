'use client';

import { useState } from 'react';
import { ProofPanel } from '@/components/explorer/ProofPanel';
import { ToolFrame } from '@/components/sandbox/ToolFrame';
import { Input, Label } from '@/components/ui/Field';
import { Button, Panel } from '@/components/ui/primitives';

export default function VerifyProof() {
  const [q, setQ] = useState('');
  const [uid, setUid] = useState<string | null>(null);
  return (
    <ToolFrame
      slug="verify-proof"
      notes={
        <>
          <p>1. A light client block is fetched and its hash computed from its fields; the block producers&apos; ed25519 approvals are checked and must hold more than 2/3 of the epoch&apos;s stake.</p>
          <p>2. <code>EXPERIMENTAL_light_client_proof</code> returns merkle paths. The receipt&apos;s outcome is hashed and walked to the block&apos;s outcome root, and the block&apos;s hash to the head&apos;s block merkle root.</p>
          <p>3. The event line must be in the outcome&apos;s logs. All of this runs here, in your browser.</p>
          <p>Trusted: the epoch&apos;s ordered block producer list as the RPC reports it.</p>
        </>
      }
    >
      <Panel className="p-5">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => (e.preventDefault(), setUid(q.trim()))}>
          <div className="flex-1">
            <Label htmlFor="u">Attestation UID</Label>
            <Input id="u" className="font-mono text-[12.5px]" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Button type="submit" disabled={!q}>Load</Button>
        </form>
      </Panel>
      {uid && <ProofPanel key={uid} uid={uid} revoked />}
    </ToolFrame>
  );
}

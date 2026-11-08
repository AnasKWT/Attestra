'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';

export default function Revoke() {
  const w = useWallet();
  const [uid, setUid] = useState('');
  return (
    <ToolFrame
      slug="revoke"
      notes={
        <>
          <p>Only the attester can revoke, and only when the schema is revocable.</p>
          <p>A resolver can refuse a revocation; the attestation then stays active. A linked credential burns automatically.</p>
        </>
      }
    >
      <ActionCard title="Revoke an attestation" label="Revoke" disabled={!uid} action={() => need(w.client).revokeAttestation(uid.trim())}>
        <div>
          <Label htmlFor="uid">Attestation UID</Label>
          <Input id="uid" className="font-mono text-[12.5px]" value={uid} onChange={(e) => setUid(e.target.value)} placeholder="64 hex characters" />
        </div>
      </ActionCard>
    </ToolFrame>
  );
}

'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';

export default function Scheduled() {
  const w = useWallet();
  const [uid, setUid] = useState('');
  const [mins, setMins] = useState('2');
  return (
    <ToolFrame
      slug="scheduled-revocation"
      notes={
        <>
          <p>The contract stores the time and every read after it reports the attestation as revoked: no transaction is needed for it to take effect.</p>
          <p>The keeper service then calls <code>finalize_revocation</code>, which writes the revocation event for indexers and burns a linked credential. Anyone may call it.</p>
        </>
      }
    >
      <ActionCard title="Schedule" label="Schedule revocation" disabled={!uid} action={() => need(w.client).scheduleRevocation(uid.trim(), Math.floor(Date.now() / 1000) + Math.max(1, Number(mins)) * 60)}>
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <div>
            <Label htmlFor="u">Attestation UID</Label>
            <Input id="u" className="font-mono text-[12.5px]" value={uid} onChange={(e) => setUid(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="m">In minutes</Label>
            <Input id="m" type="number" min={1} value={mins} onChange={(e) => setMins(e.target.value)} />
          </div>
        </div>
      </ActionCard>
      <ActionCard title="Status" label="Check" disabled={!uid} action={() => reader().getScheduledRevocation(uid.trim())} />
      <ActionCard title="Finalize" subtitle="Records the due revocation (the keeper does this automatically)" label="Finalize" disabled={!uid} action={() => need(w.client).finalizeRevocation(uid.trim())} />
    </ToolFrame>
  );
}

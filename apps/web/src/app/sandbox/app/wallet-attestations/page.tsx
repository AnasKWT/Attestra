'use client';

import { useState } from 'react';
import { AccountView } from '@/components/explorer/AccountView';
import { ToolFrame } from '@/components/sandbox/ToolFrame';
import { Input, Label } from '@/components/ui/Field';
import { Button, Panel } from '@/components/ui/primitives';
import { useWallet } from '@/components/wallet/WalletProvider';

export default function WalletAttestations() {
  const w = useWallet();
  const [q, setQ] = useState('');
  const [id, setId] = useState<string | null>(null);
  return (
    <ToolFrame slug="wallet-attestations" notes={<p>Lists come from the indexer; each attestation opens to its live on-chain record.</p>}>
      <Panel className="p-5">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => (e.preventDefault(), setId(q.trim() || w.accountId))}>
          <div className="flex-1">
            <Label htmlFor="acc">Account or CAIP-10 id</Label>
            <Input id="acc" value={q} onChange={(e) => setQ(e.target.value)} placeholder={w.accountId ?? 'alice.testnet'} />
          </div>
          <Button type="submit">Show</Button>
        </form>
      </Panel>
      {id && <div className="-mx-4 sm:-mx-6"><AccountView id={id} title={id} /></div>}
    </ToolFrame>
  );
}

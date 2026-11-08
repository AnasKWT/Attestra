'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select, Textarea } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';

export default function RegisterAuthority() {
  const w = useWallet();
  const [meta, setMeta] = useState('');
  const [kind, setKind] = useState('organization');
  const [lookup, setLookup] = useState('');
  return (
    <ToolFrame
      slug="register-authority"
      notes={
        <>
          <p>Anyone can attest; registering as an authority adds a public description that governance can verify.</p>
          <p>Updating your description clears your verification, so a verified badge always matches what was reviewed.</p>
        </>
      }
    >
      <ActionCard title="Register or update" label="Register" disabled={!meta} action={() => need(w.client).registerAuthority(meta, kind)}>
        <div>
          <Label htmlFor="meta">About you</Label>
          <Textarea id="meta" rows={3} className="font-sans text-[14px]" value={meta} onChange={(e) => setMeta(e.target.value)} placeholder="Acme Labs, issuer of contributor credentials" />
        </div>
        <div>
          <Label htmlFor="kind">Kind</Label>
          <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value)} className="sm:w-60">
            {['organization', 'person', 'agent', 'verifier', 'other'].map((k) => <option key={k}>{k}</option>)}
          </Select>
        </div>
      </ActionCard>
      <ActionCard title="Look up an authority" label="Look up" disabled={!lookup} action={() => reader().getAuthority(lookup.trim())}>
        <div>
          <Label htmlFor="who">Account</Label>
          <Input id="who" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="acme.testnet" />
        </div>
      </ActionCard>
    </ToolFrame>
  );
}

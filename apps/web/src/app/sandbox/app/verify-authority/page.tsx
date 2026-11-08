'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Toggle } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { CONTRACTS } from '@/lib/config';
import { useAsync } from '@/lib/useFetch';

export default function VerifyAuthority() {
  const w = useWallet();
  const [account, setAccount] = useState('');
  const [verified, setVerified] = useState(true);
  const cfg = useAsync(() => reader().view<{ governance: string }>(CONTRACTS.attestations, 'get_config'), []);
  return (
    <ToolFrame
      slug="verify-authority"
      notes={
        <>
          <p>Only the governance account may verify authorities. Governance is a setting of the attestations contract and can be a DAO, so verification can be a community vote.</p>
          <p>Current governance: <code>{cfg.data?.governance ?? 'reading...'}</code></p>
        </>
      }
    >
      <ActionCard title="Set verification" label={verified ? 'Verify' : 'Remove verification'} disabled={!account} action={() => need(w.client).setAuthorityVerification(account.trim(), verified)}>
        <div>
          <Label htmlFor="acc">Authority</Label>
          <Input id="acc" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="acme.testnet" />
        </div>
        <Toggle checked={verified} onChange={setVerified} label="Verified" />
      </ActionCard>
    </ToolFrame>
  );
}

'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { CONTRACTS } from '@/lib/config';

export default function Credential() {
  const w = useWallet();
  const [uid, setUid] = useState('');
  const [owner, setOwner] = useState('');
  return (
    <ToolFrame
      slug="nft-credential"
      notes={
        <>
          <p><code>{CONTRACTS.credentials}</code> reads the attestation across contracts and mints a NEP-171 token to its subject, with the attestation UID as the token id.</p>
          <p>Transfers and approvals are refused: the credential stays with the subject. When the attestation is revoked (directly or by schedule) or its expiry is recorded, the attestations contract tells the credentials contract and the token burns. Past its expiry it is gone from every view at once, and the holder can always burn a credential they do not want (<code>nft_burn</code>).</p>
        </>
      }
    >
      <ActionCard title="Mint" subtitle="As the attester or the subject of an active attestation" label="Mint credential" disabled={!uid} action={() => need(w.client).mintCredential(uid.trim())}>
        <div>
          <Label htmlFor="u">Attestation UID</Label>
          <Input id="u" className="font-mono text-[12.5px]" value={uid} onChange={(e) => setUid(e.target.value)} />
        </div>
      </ActionCard>
      <ActionCard title="Credential for an attestation" label="Read" disabled={!uid} action={() => reader().getCredential(uid.trim())} />
      <ActionCard title="Credentials of an account" label="List" disabled={!owner && !w.accountId} action={() => reader().listCredentials(owner.trim() || w.accountId!)}>
        <div>
          <Label htmlFor="o">Owner</Label>
          <Input id="o" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={w.accountId ?? 'bob.testnet'} />
        </div>
      </ActionCard>
    </ToolFrame>
  );
}

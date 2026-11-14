'use client';

import { useState } from 'react';
import type { SignedRequest } from 'attestra';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';

export default function DelegatedRevocation() {
  const w = useWallet();
  const [uid, setUid] = useState('');
  const [req, setReq] = useState<SignedRequest | null>(null);
  const [uid2, setUid2] = useState('');
  return (
    <ToolFrame
      slug="delegated-revocation"
      notes={
        <>
          <p>Sign a revocation off chain; the relayer (or anyone) submits it. Same NEP-413 rules as delegated attestations: registered signer key, deadline, one-time nonce.</p>
          <p>Delegates whose grant allows revoking can also revoke for their authority on chain.</p>
        </>
      }
    >
      <ActionCard
        title="Sign and relay a revocation"
        label="Sign and submit through the relayer"
        disabled={!uid || !w.signer}
        action={async () => {
          const s = await need(w.client).signDelegatedRevocation({ attester: w.accountId!, uid: uid.trim() }, w.signer!);
          if (!s.success || !s.data) return s as never;
          setReq(s.data);
          return reader().relaySigned(s.data);
        }}
      >
        <div>
          <Label htmlFor="uid">Attestation UID</Label>
          <Input id="uid" className="font-mono text-[12.5px]" value={uid} onChange={(e) => setUid(e.target.value)} />
        </div>
        {req && <p className="break-all font-mono text-[11.5px] text-mute">{req.message}</p>}
      </ActionCard>
      <ActionCard title="Revoke as a delegate" subtitle="Signed in as the delegate" label="Revoke on behalf" disabled={!uid2} action={() => need(w.client).revokeOnBehalf(uid2.trim())}>
        <div>
          <Label htmlFor="uid2">Attestation UID</Label>
          <Input id="uid2" className="font-mono text-[12.5px]" value={uid2} onChange={(e) => setUid2(e.target.value)} />
        </div>
      </ActionCard>
    </ToolFrame>
  );
}

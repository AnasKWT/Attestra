'use client';

import { useState } from 'react';
import { x402 } from '@attestra/sdk';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { AGENT_URL } from '@/lib/config';

export default function PaidVerify() {
  const w = useWallet();
  const [kind, setKind] = useState<'claim' | 'agent'>('claim');
  const [target, setTarget] = useState('');
  const url = `${AGENT_URL}/v1/paid/verify-${kind}?${kind === 'claim' ? 'uid' : 'agent'}=${encodeURIComponent(target.trim())}`;
  return (
    <ToolFrame
      slug="paid-verify"
      notes={
        <>
          <p>The Attestra agent sells two calls: verify a claim (with a light client proof) and check an agent (identity, reviews, delegations).</p>
          <p>Without payment it answers <code>402</code> with a <code>PAYMENT-REQUIRED</code> header. The client signs a NEP-366 delegate action holding one <code>ft_transfer</code> and repeats the call; the agent&apos;s relayer settles it. The payer needs the token, not NEAR.</p>
          <p>Testnet uses the free test token; mainnet uses USDC. Signing a delegate action needs a key you hold: use a passkey account here, or the CLI.</p>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
        <div>
          <Label htmlFor="k">Service</Label>
          <Select id="k" value={kind} onChange={(e) => setKind(e.target.value as 'claim' | 'agent')}>
            <option value="claim">Verify a claim</option>
            <option value="agent">Check an agent</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="t">{kind === 'claim' ? 'Attestation UID' : 'Agent account'}</Label>
          <Input id="t" value={target} onChange={(e) => setTarget(e.target.value)} className={kind === 'claim' ? 'font-mono text-[12.5px]' : ''} />
        </div>
      </div>
      <ActionCard title="1. See the price" subtitle="Calls without paying and decodes the 402 challenge" label="Ask for the price" disabled={!target} action={async () => {
        const res = await fetch(url);
        const h = res.headers.get(x402.X402_HEADERS.required);
        if (res.status !== 402 || !h) return { success: false, error: { type: 'UNKNOWN_ERROR' as never, message: `expected 402, got ${res.status}` } };
        return { success: true, data: x402.decodeHeader(h) };
      }} />
      <ActionCard title="2. Pay and get the answer" label="Pay and verify" disabled={!target || w.kind === 'wallet'} action={() => need(w.client).paidVerify(kind, target.trim())}>
        {w.kind === 'wallet' && <p className="text-[12.5px] text-amber-600 dark:text-amber-400">Browser wallets do not sign delegate actions; sign in with a passkey to pay here.</p>}
      </ActionCard>
    </ToolFrame>
  );
}

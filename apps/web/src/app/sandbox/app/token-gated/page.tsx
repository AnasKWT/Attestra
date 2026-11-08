'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { SchemaUidInput } from '@/components/sandbox/SchemaUidInput';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { CONTRACTS } from '@/lib/config';
import { parseAmount } from '@/lib/format';

export default function TokenGated() {
  const w = useWallet();
  const [schema, setSchema] = useState('');
  const [token, setToken] = useState(CONTRACTS.token);
  const [min, setMin] = useState('100');
  return (
    <ToolFrame
      slug="token-gated"
      notes={
        <>
          <p>On every attestation, <code>{CONTRACTS.resolvers.tokenGated}</code> calls <code>ft_balance_of</code> on the token across contracts and approves only if the attester holds at least the minimum.</p>
          <p>Get test tokens from the faucet on the Staking tool.</p>
        </>
      }
    >
      <ActionCard title="Schema admin: set the gate" label="Set gate" disabled={!schema} action={() => need(w.client).tokenGatedSetConfig(schema, token.trim(), parseAmount(min, 18))}>
        <SchemaUidInput value={schema} onChange={setSchema} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="tok">NEP-141 token</Label>
            <Input id="tok" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="min" hint="whole tokens (18 decimals)">Minimum balance</Label>
            <Input id="min" value={min} onChange={(e) => setMin(e.target.value)} />
          </div>
        </div>
      </ActionCard>
      <ActionCard title="Read the gate" label="Read" disabled={!schema} action={() => reader().tokenGatedGetConfig(schema)} />
    </ToolFrame>
  );
}

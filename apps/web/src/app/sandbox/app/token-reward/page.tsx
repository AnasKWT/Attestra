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

export default function TokenReward() {
  const w = useWallet();
  const [schema, setSchema] = useState('');
  const [amount, setAmount] = useState('5');
  const [fund, setFund] = useState('100');
  const [who, setWho] = useState('');
  return (
    <ToolFrame
      slug="token-reward"
      notes={
        <>
          <p>After an attestation commits, <code>{CONTRACTS.resolvers.tokenReward}</code> pays the subject from the schema&apos;s pool: a storage registration on the token, then <code>ft_transfer</code>. If the transfer fails, the amount returns to the pool.</p>
          <p>Fund the pool with <code>ft_transfer_call</code> and the message <code>{'{"fund":"<schema uid>"}'}</code>.</p>
        </>
      }
    >
      <ActionCard title="Schema admin: reward per attestation" label="Set reward" disabled={!schema} action={() => need(w.client).tokenRewardSetConfig(schema, CONTRACTS.token, parseAmount(amount, 18))}>
        <SchemaUidInput value={schema} onChange={setSchema} />
        <div>
          <Label htmlFor="amt" hint="test tokens">Reward</Label>
          <Input id="amt" value={amount} onChange={(e) => setAmount(e.target.value)} className="sm:w-48" />
        </div>
      </ActionCard>
      <ActionCard title="Fund the pool" label="Fund" disabled={!schema} action={() => need(w.client).tokenRewardFund(schema, CONTRACTS.token, parseAmount(fund, 18))}>
        <div>
          <Label htmlFor="fund" hint="from your test token balance">Amount</Label>
          <Input id="fund" value={fund} onChange={(e) => setFund(e.target.value)} className="sm:w-48" />
        </div>
      </ActionCard>
      <ActionCard title="Pool and payouts" label="Read" disabled={!schema} action={async () => {
        const cfg = await reader().tokenRewardGetConfig(schema);
        const paid = who ? await reader().tokenRewardGetDistributed(schema, who.trim()) : null;
        return { success: true, data: { config: cfg.data, paid_to_account: paid?.data?.distributed ?? null } };
      }}>
        <div>
          <Label htmlFor="who" hint="optional">Subject</Label>
          <Input id="who" value={who} onChange={(e) => setWho(e.target.value)} placeholder="bob.testnet" />
        </div>
      </ActionCard>
    </ToolFrame>
  );
}

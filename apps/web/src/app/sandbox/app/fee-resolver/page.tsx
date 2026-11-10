'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { SchemaUidInput } from '@/components/sandbox/SchemaUidInput';
import { need } from '@/components/sandbox/need';
import { Input, Select } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { CONTRACTS } from '@/lib/config';
import { parseAmount } from '@/lib/format';

export default function Fee() {
  const w = useWallet();
  const [schema, setSchema] = useState('');
  const [asset, setAsset] = useState<'near' | 'token'>('near');
  const [amount, setAmount] = useState('0.01');
  const token = asset === 'token' ? CONTRACTS.token : undefined;
  const decimals = asset === 'token' ? 18 : 24;
  const units = () => parseAmount(amount, decimals);
  return (
    <ToolFrame
      slug="fee-resolver"
      notes={
        <>
          <p>Attesters prepay a balance on <code>{CONTRACTS.resolvers.fee}</code> (NEAR with <code>deposit</code>, the test token with <code>ft_transfer_call</code>). Each attestation deducts the fee.</p>
          <p>A charge is held until the attestation commits; if a later step in a pipeline refuses, the fee is refunded. Committed fees go to the schema admin.</p>
        </>
      }
    >
      <div className="flex gap-2">
        <Select aria-label="Asset" value={asset} onChange={(e) => setAsset(e.target.value as 'near' | 'token')} className="w-56">
          <option value="near">NEAR</option>
          <option value="token">Test token (tATT)</option>
        </Select>
        <Input aria-label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-40" />
      </div>
      <ActionCard title="Schema admin: set the fee" label="Set fee" disabled={!schema} action={() => need(w.client).feeSetFee(schema, units(), token)}>
        <SchemaUidInput value={schema} onChange={setSchema} />
      </ActionCard>
      <ActionCard title="Attester: prepay" subtitle="Adds to your fee balance" label="Deposit" action={() => need(w.client).feeDeposit(units(), token)} />
      <ActionCard title="Balances" label="Read" disabled={!w.accountId} action={async () => {
        const [fee, bal, col] = await Promise.all([schema ? reader().feeGetFee(schema) : Promise.resolve({ success: true, data: null }), reader().feeGetBalance(w.accountId!, token), schema ? reader().feeCollected(schema, token) : Promise.resolve({ success: true, data: { collected: '0' } })]);
        return { success: true, data: { fee: fee.data, your_balance: bal.data?.balance, collected_for_schema: (col.data as { collected: string } | undefined)?.collected } };
      }} />
      <ActionCard title="Schema admin: withdraw collected fees" label="Withdraw fees" disabled={!schema} action={() => need(w.client).feeWithdraw(schema, token)} />
    </ToolFrame>
  );
}

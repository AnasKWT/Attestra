'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { Badge, Panel, PanelHeader } from '@/components/ui/primitives';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { CONTRACTS } from '@/lib/config';
import { formatAmount, parseAmount } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

export default function Staking() {
  const w = useWallet();
  const [amount, setAmount] = useState('100');
  const tiers = useAsync(() => reader().getTiers(), []);
  return (
    <ToolFrame
      slug="token-staking"
      notes={
        <>
          <p>Stake the test token on <code>{CONTRACTS.staking}</code> with <code>ft_transfer_call</code>. The staking contract pushes your tier to the attestations contract, so every authority record shows it.</p>
          <p>Get tokens from the faucet first: 1,000 per hour.</p>
        </>
      }
      aside={
        <Panel>
          <PanelHeader title="Tiers" />
          <ul className="space-y-2 px-5 py-4 text-[13px]">
            {(tiers.data?.data ?? []).map((t) => (
              <li key={t.name} className="flex items-center justify-between">
                <Badge tone="brand">{t.name}</Badge>
                <span className="font-mono text-soft">{formatAmount(t.min, 18)} tATT</span>
              </li>
            ))}
          </ul>
        </Panel>
      }
    >
      <ActionCard title="Faucet" subtitle="Test tokens, testnet only" label="Get 1,000 tATT" action={() => need(w.client).faucet()} />
      <ActionCard title="Stake" label="Stake" action={() => need(w.client).stake(parseAmount(amount, 18))}>
        <div>
          <Label htmlFor="a">Amount (tATT)</Label>
          <Input id="a" value={amount} onChange={(e) => setAmount(e.target.value)} className="sm:w-48" />
        </div>
      </ActionCard>
      <ActionCard title="Unstake" label="Unstake" action={() => need(w.client).unstake(parseAmount(amount, 18))} />
      <ActionCard title="My stake" label="Read" disabled={!w.accountId} action={async () => {
        const [s, b, a] = await Promise.all([reader().getStake(w.accountId!), reader().tokenBalance(w.accountId!), reader().getAuthority(w.accountId!)]);
        return { success: true, data: { staked: formatAmount(s.data?.staked ?? '0', 18), tier: s.data?.tier ?? null, wallet_balance: formatAmount(b.data?.balance ?? '0', 18), tier_on_authority_record: a.data?.tier ?? '(register as an authority to show it)' } };
      }} />
    </ToolFrame>
  );
}

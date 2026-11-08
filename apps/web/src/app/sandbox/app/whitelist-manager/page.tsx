'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { SchemaUidInput } from '@/components/sandbox/SchemaUidInput';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { CONTRACTS } from '@/lib/config';

export default function Whitelist() {
  const w = useWallet();
  const [schema, setSchema] = useState('');
  const [account, setAccount] = useState('');
  return (
    <ToolFrame
      slug="whitelist-manager"
      notes={
        <>
          <p>Register a schema with resolver <code>{CONTRACTS.resolvers.whitelist}</code> (Schema Deployer). You become that schema&apos;s admin on the resolver.</p>
          <p>Then only accounts you add here can attest under it. Anyone else is rejected: the attestation is rolled back and its storage refunded.</p>
        </>
      }
    >
      <ActionCard title="Manage the list" label="Add to whitelist" disabled={!schema || !account} action={() => need(w.client).whitelistAdd(schema, account.trim())}>
        <SchemaUidInput value={schema} onChange={setSchema} />
        <div>
          <Label htmlFor="acc">Attester account</Label>
          <Input id="acc" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="issuer.testnet" />
        </div>
      </ActionCard>
      <ActionCard title="Remove" label="Remove from whitelist" disabled={!schema || !account} action={() => need(w.client).whitelistRemove(schema, account.trim())} />
      <ActionCard title="Check" label="Is it whitelisted?" disabled={!schema || !account} action={() => reader().whitelistCheck(schema, account.trim())} />
    </ToolFrame>
  );
}

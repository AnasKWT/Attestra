'use client';

import { useState } from 'react';
import { KNOWN_SCHEMAS, SchemaEncoder, knownSchemaUid, type Outcome, type ServiceResponse } from '@attestra/sdk';
import { ActionCard, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label } from '@/components/ui/Field';
import { Alert } from '@/components/ui/primitives';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { formatAmount } from '@/lib/format';

export default function Gasless() {
  const w = useWallet();
  const [subject, setSubject] = useState('');
  const [org, setOrg] = useState('Attestra community');
  const [role, setRole] = useState('member');
  return (
    <ToolFrame
      slug="gasless"
      notes={
        <>
          <p>The issuer signs a NEP-413 request; the relayer submits it, pays the gas and, if needed, the storage, within a daily budget and an allowlist.</p>
          <p>With a passkey account the signing key is the account itself, so nothing needs registering: a person can issue from a phone with Face ID and no NEAR.</p>
          <p>Issuers can also use NEP-366 meta transactions through the relayer&apos;s <code>/v1/meta</code> endpoint.</p>
        </>
      }
    >
      {w.kind !== 'passkey' && <Alert tone="info" title="Best with a passkey">Sign in with a passkey to see an issuer with no NEAR. Wallet users need to register their signing key once.</Alert>}
      <ActionCard
        title="Issue a membership without gas"
        label="Sign and relay"
        disabled={!subject || !w.signer}
        action={async (): Promise<ServiceResponse<Outcome & { issuer_balance_before?: string; issuer_balance_after?: string }>> => {
          const before = await reader().rpc<{ amount: string }>('query', { request_type: 'view_account', finality: 'optimistic', account_id: w.accountId }).catch(() => ({ amount: '0' }));
          const data = new SchemaEncoder(KNOWN_SCHEMAS.membership.definition).encode({ organization: org, role, since: String(Math.floor(Date.now() / 1000)) });
          const signed = await need(w.client).signDelegatedAttestation({ attester: w.accountId!, schemaUid: knownSchemaUid('membership'), subject: subject.trim(), data }, w.signer!);
          if (!signed.success || !signed.data) return signed as never;
          const r = await reader().relaySigned(signed.data);
          const after = await reader().rpc<{ amount: string }>('query', { request_type: 'view_account', finality: 'optimistic', account_id: w.accountId }).catch(() => ({ amount: '0' }));
          return r.success ? { ...r, data: { ...r.data!, issuer_balance_before: formatAmount(before.amount), issuer_balance_after: formatAmount(after.amount) } } : r;
        }}
        render={(d) => (
          <div className="space-y-2 text-[13px]">
            <UidResult uid={d.uid} kind="attestations" />
            <p className="text-soft">Your NEAR balance: {d.issuer_balance_before} before, {d.issuer_balance_after} after. The relayer paid.</p>
          </div>
        )}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div><Label htmlFor="s">Member</Label><Input id="s" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="bob.testnet" /></div>
          <div><Label htmlFor="o">Organization</Label><Input id="o" value={org} onChange={(e) => setOrg(e.target.value)} /></div>
          <div><Label htmlFor="r">Role</Label><Input id="r" value={role} onChange={(e) => setRole(e.target.value)} /></div>
        </div>
      </ActionCard>
    </ToolFrame>
  );
}

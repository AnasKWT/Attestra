'use client';

import { BadgeCheck, Fingerprint, Wallet } from 'lucide-react';
import Link from 'next/link';
import { AccountView } from '@/components/explorer/AccountView';
import { Badge, Button, Empty, Panel, PanelHeader } from '@/components/ui/primitives';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { formatTime } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

export default function Profile() {
  const w = useWallet();
  const creds = useAsync(async () => (w.accountId ? (await reader().listCredentials(w.accountId)).data ?? [] : []), [w.accountId]);
  if (!w.accountId) {
    return (
      <div className="mx-auto max-w-xl px-4 py-24 text-center sm:px-6">
        <h1 className="text-3xl font-semibold text-fg">Your profile</h1>
        <p className="mt-3 text-[15px] text-soft">Sign in to see what you issued, what was issued about you, and your credentials.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button onClick={() => void w.connectWallet()}><Wallet className="size-4" />NEAR wallet</Button>
          <Button variant="secondary" onClick={() => void w.signInPasskey()}><Fingerprint className="size-4" />Passkey</Button>
        </div>
        <button onClick={() => void w.createPasskey()} className="mt-4 text-[13px] text-accent hover:underline">No wallet? Create a passkey account</button>
        {w.error && <p className="mt-4 text-[13px] text-red-500">{w.error}</p>}
      </div>
    );
  }
  return (
    <div>
      <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
        <Panel>
          <PanelHeader icon={<BadgeCheck className="size-4" />} title="Credentials" subtitle="Non-transferable NEP-171 tokens held by this account. Each burns if its attestation is revoked." right={<Badge>{w.kind === 'passkey' ? 'passkey account' : 'wallet'}</Badge>} />
          {creds.data && creds.data.length === 0 ? (
            <Empty title="No credentials yet">Mint one for an attestation about you with the <Link className="text-accent hover:underline" href="/sandbox/app/nft-credential">credential tool</Link>.</Empty>
          ) : (
            <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
              {(creds.data ?? []).map((c) => (
                <Link key={c.token_id} href={`/attestations/${c.token_id}`} className="group rounded-lg border border-line bg-panel-2 p-4 transition-colors hover:border-line-strong">
                  <p className="font-display text-[15px] font-semibold text-fg">{c.metadata?.title ?? 'Credential'}</p>
                  <p className="mt-1 line-clamp-2 text-[12.5px] text-soft">{c.metadata?.description}</p>
                  <p className="mt-3 font-mono text-[11px] text-mute">{c.token_id.slice(0, 16)}...</p>
                  {c.metadata?.issued_at && <p className="text-[11.5px] text-mute">issued {formatTime(Number(c.metadata.issued_at) / 1000)}</p>}
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>
      <AccountView id={w.accountId} title="Your activity" />
    </div>
  );
}

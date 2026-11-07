'use client';

import { Landmark, User } from 'lucide-react';
import Link from 'next/link';
import type { IndexedAttestation } from '@attestra/sdk';
import { Hash } from '../ui/Copy';
import { Alert, Badge, Panel, PanelHeader } from '../ui/primitives';
import { indexer } from '@/lib/client';
import { accountUrl } from '@/lib/config';
import { timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';
import { ExplorerShell } from './ExplorerShell';
import { AccountLink, UidLink } from './Links';
import { DataTable } from './Table';
import { StatusBadge } from '../ui/primitives';

function List({ title, rows, loading, error, who }: { title: string; rows: IndexedAttestation[] | null; loading: boolean; error: string | null; who: 'attester' | 'subject' }) {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold text-fg">{title}</h2>
      <DataTable<IndexedAttestation>
        loading={loading}
        error={error}
        rows={rows}
        onRow={(r) => `/attestations/${r.uid}`}
        columns={[
          { key: 'uid', header: 'UID', cell: (r) => <UidLink uid={r.uid} kind="attestations" /> },
          { key: 'schema', header: 'Schema', cell: (r) => <UidLink uid={r.schema_uid} kind="schemas" /> },
          { key: 'who', header: who === 'attester' ? 'Subject' : 'Attester', cell: (r) => <AccountLink id={who === 'attester' ? r.subject : r.attester} /> },
          { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'age', header: 'Issued', cell: (r) => <span className="text-soft">{timeAgo(r.created_at)}</span>, className: 'text-right' },
        ]}
      />
    </div>
  );
}

export function AccountView({ id, title }: { id: string; title?: string }) {
  const p = useAsync(() => indexer.getProfile(id), [id]);
  const caip = id.includes(':');
  return (
    <ExplorerShell title={title ?? 'Account'} intro={<Hash value={id} full external={caip ? undefined : accountUrl(id)} />}>
      {p.error && <Alert tone="warn">{p.error}</Alert>}
      <div className="space-y-8">
        {p.data?.authority && (
          <Panel>
            <PanelHeader icon={<Landmark className="size-4" />} title="Registered authority" subtitle={p.data.authority.metadata} right={<Link className="text-[13px] text-accent hover:underline" href={`/authorities/${encodeURIComponent(id)}`}>Authority page</Link>} />
            <div className="flex flex-wrap gap-2 px-5 py-3">
              <Badge>{p.data.authority.kind}</Badge>
              {p.data.authority.verified && <Badge tone="ok">verified</Badge>}
              {p.data.authority.tier && <Badge tone="brand">{p.data.authority.tier}</Badge>}
            </div>
          </Panel>
        )}
        {caip && (
          <Alert tone="info" title="A wallet on another chain">
            This subject is a CAIP-10 account id. Attestations can name wallets on any chain; a wallet link attestation proves which NEAR account controls it.
          </Alert>
        )}
        <List title="Received" rows={p.data?.received ?? null} loading={p.loading} error={p.error} who="subject" />
        <List title="Issued" rows={p.data?.issued ?? null} loading={p.loading} error={p.error} who="attester" />
        {!p.loading && p.data && p.data.issued.length === 0 && p.data.received.length === 0 && !p.data.authority && (
          <div className="flex items-center gap-2 text-[13px] text-mute"><User className="size-4" />No activity indexed for this account yet.</div>
        )}
      </div>
    </ExplorerShell>
  );
}

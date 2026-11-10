'use client';

import { BadgeCheck } from 'lucide-react';
import { useState } from 'react';
import type { IndexedAuthority } from '@attestra/sdk';
import { ExplorerShell } from '@/components/explorer/ExplorerShell';
import { AccountLink } from '@/components/explorer/Links';
import { DataTable, Pager } from '@/components/explorer/Table';
import { Select } from '@/components/ui/Field';
import { Badge } from '@/components/ui/primitives';
import { indexer } from '@/lib/client';
import { timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

const LIMIT = 20;

export default function AuthoritiesPage() {
  const [offset, setOffset] = useState(0);
  const [verified, setVerified] = useState('');
  const { data, error, loading } = useAsync(() => indexer.listAuthorities({ limit: LIMIT, offset, verified: verified === '' ? undefined : verified === 'true' }), [offset, verified]);
  return (
    <ExplorerShell
      title="Authorities"
      intro="Issuers who registered themselves. Governance verifies them; staking gives them a tier anyone can read."
      actions={
        <Select aria-label="Filter by verification" value={verified} onChange={(e) => (setOffset(0), setVerified(e.target.value))} className="w-44">
          <option value="">All authorities</option>
          <option value="true">Verified</option>
          <option value="false">Not verified</option>
        </Select>
      }
    >
      <DataTable<IndexedAuthority>
        loading={loading}
        error={error}
        rows={data?.data ?? null}
        onRow={(r) => `/authorities/${r.account_id}`}
        columns={[
          { key: 'id', header: 'Account', cell: (r) => <AccountLink id={r.account_id} /> },
          { key: 'meta', header: 'About', cell: (r) => <span className="block max-w-[320px] truncate text-soft">{r.metadata}</span> },
          { key: 'kind', header: 'Kind', cell: (r) => <Badge>{r.kind}</Badge> },
          { key: 'ver', header: 'Verified', cell: (r) => (r.verified ? <Badge tone="ok"><BadgeCheck className="size-3" />verified</Badge> : <span className="text-mute">no</span>) },
          { key: 'tier', header: 'Tier', cell: (r) => (r.tier ? <Badge tone="brand">{r.tier}</Badge> : <span className="text-mute">none</span>) },
          { key: 'n', header: 'Issued', cell: (r) => <span className="tabular-nums">{r.attestation_count}</span>, className: 'text-right' },
          { key: 'age', header: 'Since', cell: (r) => <span className="whitespace-nowrap text-soft">{timeAgo(r.registered_at)}</span>, className: 'text-right' },
        ]}
      />
      {data && <Pager total={data.pagination.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
    </ExplorerShell>
  );
}

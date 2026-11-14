'use client';

import { useState } from 'react';
import type { IndexedSchema } from 'attestra';
import { ExplorerShell } from '@/components/explorer/ExplorerShell';
import { AccountLink, UidLink } from '@/components/explorer/Links';
import { DataTable, Pager } from '@/components/explorer/Table';
import { Input } from '@/components/ui/Field';
import { Badge } from '@/components/ui/primitives';
import { indexer } from '@/lib/client';
import { timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

const LIMIT = 20;

export default function SchemasPage() {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const { data, error, loading } = useAsync(() => indexer.listSchemas({ limit: LIMIT, offset, search: search || undefined }), [offset, search]);
  return (
    <ExplorerShell
      title="Schemas"
      intro="The shapes of claims. A schema's UID is derived from its definition, resolver and revocability, so it is the same everywhere."
      actions={<Input aria-label="Search schemas" placeholder="Search fields, UID or authority" className="w-72" value={search} onChange={(e) => (setOffset(0), setSearch(e.target.value))} />}
    >
      <DataTable<IndexedSchema>
        loading={loading}
        error={error}
        rows={data?.data ?? null}
        onRow={(r) => `/schemas/${r.uid}`}
        columns={[
          { key: 'uid', header: 'UID', cell: (r) => <UidLink uid={r.uid} kind="schemas" /> },
          { key: 'def', header: 'Definition', cell: (r) => <span className="block max-w-[360px] truncate font-mono text-[12px] text-soft" title={r.definition}>{r.definition}</span> },
          { key: 'auth', header: 'Authority', cell: (r) => <AccountLink id={r.authority} /> },
          { key: 'res', header: 'Resolver', cell: (r) => (r.resolver ? <Badge tone="brand">{r.resolver.split('.')[0]}</Badge> : <span className="text-mute">none</span>) },
          { key: 'count', header: 'Attestations', cell: (r) => <span className="tabular-nums">{r.attestation_count}</span>, className: 'text-right' },
          { key: 'age', header: 'Registered', cell: (r) => <span className="whitespace-nowrap text-soft">{timeAgo(r.created_at)}</span>, className: 'text-right' },
        ]}
      />
      {data && <Pager total={data.pagination.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
    </ExplorerShell>
  );
}

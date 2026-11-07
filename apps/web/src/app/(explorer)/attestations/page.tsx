'use client';

import { useState } from 'react';
import type { IndexedAttestation } from '@attestra/sdk';
import { ExplorerShell } from '@/components/explorer/ExplorerShell';
import { AccountLink, UidLink } from '@/components/explorer/Links';
import { DataTable, Pager } from '@/components/explorer/Table';
import { Select } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/primitives';
import { indexer } from '@/lib/client';
import { timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

const LIMIT = 20;

export default function AttestationsPage() {
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const { data, error, loading } = useAsync(() => indexer.listAttestations({ limit: LIMIT, offset, status: status || undefined }), [offset, status]);
  return (
    <ExplorerShell
      title="Attestations"
      intro="Every attestation issued on Attestra. Status accounts for expiry and scheduled revocation at the moment you read it."
      actions={
        <Select aria-label="Filter by status" value={status} onChange={(e) => (setOffset(0), setStatus(e.target.value))} className="w-44">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="revoked">Revoked</option>
          <option value="expired">Expired</option>
        </Select>
      }
    >
      <DataTable<IndexedAttestation>
        loading={loading}
        error={error}
        rows={data?.data ?? null}
        onRow={(r) => `/attestations/${r.uid}`}
        empty="Issue one from the sandbox and it shows up here within seconds."
        columns={[
          { key: 'uid', header: 'UID', cell: (r) => <UidLink uid={r.uid} kind="attestations" /> },
          { key: 'schema', header: 'Schema', cell: (r) => <UidLink uid={r.schema_uid} kind="schemas" /> },
          { key: 'attester', header: 'Attester', cell: (r) => <AccountLink id={r.attester} /> },
          { key: 'subject', header: 'Subject', cell: (r) => <AccountLink id={r.subject} /> },
          { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'age', header: 'Issued', cell: (r) => <span className="text-soft">{timeAgo(r.created_at)}</span>, className: 'text-right' },
        ]}
      />
      {data && <Pager total={data.pagination.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
    </ExplorerShell>
  );
}

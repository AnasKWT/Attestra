'use client';

import { useState } from 'react';
import type { IndexedAttestation } from '@attestra/sdk';
import { AccountLink, UidLink } from '@/components/explorer/Links';
import { DataTable } from '@/components/explorer/Table';
import { ToolFrame } from '@/components/sandbox/ToolFrame';
import { Input, Label } from '@/components/ui/Field';
import { Button, Panel, StatusBadge } from '@/components/ui/primitives';
import { indexer } from '@/lib/client';
import { timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

export default function SchemaAttestations() {
  const [q, setQ] = useState('');
  const [uid, setUid] = useState<string | null>(null);
  const r = useAsync(async () => (uid ? indexer.listAttestations({ schema: uid, limit: 50 }) : null), [uid]);
  return (
    <ToolFrame slug="schema-attestations">
      <Panel className="p-5">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => (e.preventDefault(), setUid(q.trim()))}>
          <div className="flex-1">
            <Label htmlFor="s">Schema UID</Label>
            <Input id="s" className="font-mono text-[12.5px]" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Button type="submit" disabled={!q}>Show</Button>
        </form>
      </Panel>
      {uid && (
        <DataTable<IndexedAttestation>
          loading={r.loading}
          error={r.error}
          rows={r.data?.data ?? null}
          onRow={(a) => `/attestations/${a.uid}`}
          columns={[
            { key: 'uid', header: 'UID', cell: (a) => <UidLink uid={a.uid} kind="attestations" /> },
            { key: 'att', header: 'Attester', cell: (a) => <AccountLink id={a.attester} /> },
            { key: 'sub', header: 'Subject', cell: (a) => <AccountLink id={a.subject} /> },
            { key: 'st', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
            { key: 'age', header: 'Issued', cell: (a) => <span className="whitespace-nowrap text-soft">{timeAgo(a.created_at)}</span>, className: 'text-right' },
          ]}
        />
      )}
    </ToolFrame>
  );
}

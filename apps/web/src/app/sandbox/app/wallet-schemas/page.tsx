'use client';

import { useState } from 'react';
import type { IndexedSchema } from 'attestra';
import { UidLink } from '@/components/explorer/Links';
import { DataTable } from '@/components/explorer/Table';
import { ToolFrame } from '@/components/sandbox/ToolFrame';
import { Input, Label } from '@/components/ui/Field';
import { Button, Panel } from '@/components/ui/primitives';
import { useWallet } from '@/components/wallet/WalletProvider';
import { indexer } from '@/lib/client';
import { timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

export default function WalletSchemas() {
  const w = useWallet();
  const [q, setQ] = useState('');
  const [id, setId] = useState<string | null>(null);
  const r = useAsync(async () => (id ? indexer.listSchemas({ authority: id, limit: 50 }) : null), [id]);
  return (
    <ToolFrame slug="wallet-schemas">
      <Panel className="p-5">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(e) => (e.preventDefault(), setId(q.trim() || w.accountId))}>
          <div className="flex-1">
            <Label htmlFor="acc">Authority</Label>
            <Input id="acc" value={q} onChange={(e) => setQ(e.target.value)} placeholder={w.accountId ?? 'alice.testnet'} />
          </div>
          <Button type="submit">Show</Button>
        </form>
      </Panel>
      {id && (
        <DataTable<IndexedSchema>
          loading={r.loading}
          error={r.error}
          rows={r.data?.data ?? null}
          onRow={(s) => `/schemas/${s.uid}`}
          columns={[
            { key: 'uid', header: 'UID', cell: (s) => <UidLink uid={s.uid} kind="schemas" /> },
            { key: 'def', header: 'Definition', cell: (s) => <span className="block max-w-[360px] truncate font-mono text-[12px] text-soft">{s.definition}</span> },
            { key: 'n', header: 'Attestations', cell: (s) => s.attestation_count, className: 'text-right' },
            { key: 'age', header: 'Registered', cell: (s) => <span className="whitespace-nowrap text-soft">{timeAgo(s.created_at)}</span>, className: 'text-right' },
          ]}
        />
      )}
    </ToolFrame>
  );
}

'use client';

import { Layers } from 'lucide-react';
import Link from 'next/link';
import { parseSchema, type IndexedAttestation } from '@attestra/sdk';
import { ExplorerShell } from '@/components/explorer/ExplorerShell';
import { AccountLink, UidLink } from '@/components/explorer/Links';
import { DataTable } from '@/components/explorer/Table';
import { Hash } from '@/components/ui/Copy';
import { Alert, Badge, KeyValue, Panel, PanelHeader, Skeleton, StatusBadge, buttonClass } from '@/components/ui/primitives';
import { indexer, reader } from '@/lib/client';
import { txUrl } from '@/lib/config';
import { formatTime, timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

export function SchemaDetail({ uid }: { uid: string }) {
  const chain = useAsync(async () => {
    const r = await reader().getSchema(uid);
    if (!r.success || !r.data) throw new Error(r.error?.message ?? 'not found');
    return r.data;
  }, [uid]);
  const idx = useAsync(() => indexer.getSchema(uid), [uid]);
  const atts = useAsync(() => indexer.listAttestations({ schema: uid, limit: 10 }), [uid]);
  let fields: Array<{ type: string; name: string }> = [];
  try {
    fields = chain.data ? parseSchema(chain.data.definition) : [];
  } catch {
    fields = [];
  }
  return (
    <ExplorerShell
      title="Schema"
      intro={<Hash value={uid} full className="text-[13px]" />}
      actions={chain.data && <Link href={`/sandbox/app/create-attestation?schema=${uid}`} className={buttonClass('primary', 'md')}>Attest with this schema</Link>}
    >
      {chain.error && <Alert tone="bad" title="Not found on chain">{chain.error}</Alert>}
      {chain.loading && <Skeleton className="h-64 w-full" />}
      {chain.data && (
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel>
              <PanelHeader icon={<Layers className="size-4" />} title="Definition" subtitle={chain.data.blob_hash ? 'Stored as an on-chain blob (large schema)' : 'Stored inline'} right={<StatusBadge status={chain.data.status} />} />
              <div className="p-5">
                <div className="overflow-hidden rounded-xl border border-line">
                  <table className="w-full text-left text-[13px]">
                    <thead>
                      <tr className="border-b border-line bg-panel-2 font-mono text-[10.5px] uppercase tracking-wider text-mute">
                        <th className="px-3 py-2">Field</th>
                        <th className="px-3 py-2">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fields.slice(0, 40).map((f) => (
                        <tr key={f.name} className="border-b border-line last:border-0">
                          <td className="px-3 py-2 font-mono text-[12.5px] text-fg">{f.name}</td>
                          <td className="px-3 py-2"><Badge tone="brand">{f.type}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {fields.length > 40 && <p className="border-t border-line px-3 py-2 text-[12px] text-mute">and {fields.length - 40} more fields</p>}
                </div>
              </div>
            </Panel>
            <Panel>
              <PanelHeader title="Details" />
              <dl className="px-5 py-2">
                <KeyValue label="Authority"><AccountLink id={chain.data.authority} /></KeyValue>
                <KeyValue label="Resolver">{chain.data.resolver ? <span className="font-mono text-[12.5px]">{chain.data.resolver}</span> : 'none'}</KeyValue>
                <KeyValue label="Revocable">{chain.data.revocable ? 'yes' : 'no'}</KeyValue>
                <KeyValue label="Registered">{formatTime(chain.data.created_at)}</KeyValue>
                {chain.data.blob_hash && <KeyValue label="Blob"><Hash value={chain.data.blob_hash} /></KeyValue>}
                {idx.data?.tx_hash && <KeyValue label="Transaction"><Hash value={idx.data.tx_hash} external={txUrl(idx.data.tx_hash)} /></KeyValue>}
                <KeyValue label="Attestations">{idx.data?.attestation_count ?? 'unknown'}</KeyValue>
              </dl>
            </Panel>
          </div>
          <div>
            <h2 className="mb-3 text-lg font-semibold text-fg">Recent attestations</h2>
            <DataTable<IndexedAttestation>
              loading={atts.loading}
              error={atts.error}
              rows={atts.data?.data ?? null}
              onRow={(r) => `/attestations/${r.uid}`}
              columns={[
                { key: 'uid', header: 'UID', cell: (r) => <UidLink uid={r.uid} kind="attestations" /> },
                { key: 'att', header: 'Attester', cell: (r) => <AccountLink id={r.attester} /> },
                { key: 'sub', header: 'Subject', cell: (r) => <AccountLink id={r.subject} /> },
                { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                { key: 'age', header: 'Issued', cell: (r) => <span className="text-soft">{timeAgo(r.created_at)}</span>, className: 'text-right' },
              ]}
            />
          </div>
        </div>
      )}
    </ExplorerShell>
  );
}

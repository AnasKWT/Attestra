'use client';

import { useState } from 'react';
import type { IndexedEvent } from '@attestra/sdk';
import { ExplorerShell } from '@/components/explorer/ExplorerShell';
import { AccountLink } from '@/components/explorer/Links';
import { DataTable, Pager } from '@/components/explorer/Table';
import { Hash } from '@/components/ui/Copy';
import { Select } from '@/components/ui/Field';
import { Badge, type Tone } from '@/components/ui/primitives';
import { indexer } from '@/lib/client';
import { txUrl } from '@/lib/config';
import { timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/useFetch';

const LIMIT = 25;
const TONE: Record<string, Tone> = { created: 'ok', registered: 'ok', revoked: 'bad', rejected: 'bad', verified: 'info', pending: 'warn', scheduled: 'info', minted: 'ok', burned: 'bad', accepted: 'ok', linked: 'info' };
const toneOf = (e: string) => TONE[e.split('_').pop() ?? ''] ?? 'neutral';

const EVENTS = ['attestation_created', 'attestation_revoked', 'attestation_rejected', 'revocation_scheduled', 'attestation_expired', 'schema_registered', 'authority_registered', 'authority_verified', 'delegate_added', 'multisig_executed', 'credential_minted', 'credential_burned', 'verdict_accepted', 'foreign_tx_verified', 'wallet_linked', 'fee_charged', 'reward_paid', 'stake_changed'];

export default function AuditLogPage() {
  const [offset, setOffset] = useState(0);
  const [event, setEvent] = useState('');
  const { data, error, loading } = useAsync(() => indexer.listEvents({ limit: LIMIT, offset, event: event || undefined }), [offset, event]);
  return (
    <ExplorerShell
      title="Audit log"
      intro="Every state change is a NEP-297 event in a receipt. Open an attestation to prove its event is final with a light client proof."
      actions={
        <Select aria-label="Filter by event" value={event} onChange={(e) => (setOffset(0), setEvent(e.target.value))} className="w-60">
          <option value="">All events</option>
          {EVENTS.map((e) => (
            <option key={e} value={e}>
              {e.replaceAll('_', ' ')}
            </option>
          ))}
        </Select>
      }
    >
      <DataTable<IndexedEvent>
        loading={loading}
        error={error}
        rows={data?.data ?? null}
        columns={[
          { key: 'ev', header: 'Event', cell: (r) => <Badge tone={toneOf(r.event)}>{r.event.replaceAll('_', ' ')}</Badge> },
          { key: 'contract', header: 'Contract', cell: (r) => <span className="font-mono text-[12px] text-soft">{r.contract.split('.')[0]}</span> },
          { key: 'who', header: 'Signer', cell: (r) => <AccountLink id={r.signer_id} /> },
          { key: 'uid', header: 'Subject of the event', cell: (r) => (r.uid ? <Hash value={r.uid} href={r.event.includes('schema') ? `/schemas/${r.uid}` : `/attestations/${r.uid}`} head={6} tail={4} /> : <span className="text-mute">none</span>) },
          { key: 'tx', header: 'Transaction', cell: (r) => <Hash value={r.tx_hash} external={txUrl(r.tx_hash)} head={6} tail={4} /> },
          { key: 'block', header: 'Block', cell: (r) => <span className="font-mono text-[12px] tabular-nums text-soft">{r.block_height.toLocaleString()}</span> },
          { key: 'age', header: 'When', cell: (r) => <span className="text-soft">{timeAgo(r.block_timestamp / 1000)}</span>, className: 'text-right' },
        ]}
      />
      {data && <Pager total={data.pagination.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
    </ExplorerShell>
  );
}

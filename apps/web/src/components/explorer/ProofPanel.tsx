'use client';

import { CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { ProofResult } from '@attestra/sdk';
import { reader } from '@/lib/client';
import { Hash } from '../ui/Copy';
import { Alert, Button, Panel, PanelHeader } from '../ui/primitives';

/** Proves in the browser that the event behind an attestation is in a final NEAR block. */
export function ProofPanel({ uid, revoked = false }: { uid: string; revoked?: boolean }) {
  const [which, setWhich] = useState<'attestation_created' | 'attestation_revoked'>('attestation_created');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<(ProofResult & { txHash: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    const r = await reader().proveAttestation(uid, which);
    if (r.success && r.data) setRes(r.data);
    else setErr(r.error?.message ?? 'the proof could not be built');
    setBusy(false);
  };

  return (
    <Panel>
      <PanelHeader
        icon={<ShieldCheck className="size-4" />}
        title="Light client proof"
        subtitle="Checked here in your browser: validator approvals of a final head, then merkle paths from the receipt to that head. No trust in the indexer."
        right={
          <div className="flex items-center gap-2">
            {revoked && (
              <div className="inline-flex rounded-lg border border-line p-0.5 text-[12px]">
                {(['attestation_created', 'attestation_revoked'] as const).map((w) => (
                  <button key={w} onClick={() => setWhich(w)} className={`rounded-md px-2 py-1 ${which === w ? 'bg-accent-soft text-accent' : 'text-mute'}`}>
                    {w === 'attestation_created' ? 'creation' : 'revocation'}
                  </button>
                ))}
              </div>
            )}
            <Button size="sm" onClick={run} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
              {busy ? 'Proving' : 'Prove it'}
            </Button>
          </div>
        }
      />
      <div className="p-5">
        {!res && !err && !busy && <p className="text-[13.5px] text-mute">Press prove: the browser fetches a light client block, checks that more than two thirds of stake signed it, then walks the outcome and block proofs locally.</p>}
        {busy && <p className="text-[13.5px] text-mute">Fetching the light client block and the proof from NEAR RPC...</p>}
        {err && <Alert tone="warn">{err}</Alert>}
        {res && (
          <div className="space-y-4">
            <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-[14px] font-medium ${res.verified ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'border-red-500/30 bg-red-500/10 text-red-600'}`}>
              {res.verified ? <CheckCircle2 className="size-5" /> : <XCircle className="size-5" />}
              {res.verified ? `Final: the event is in block ${res.block.height.toLocaleString()}, an ancestor of the approved head ${res.head.height.toLocaleString()}.` : 'The proof did not verify.'}
            </div>
            <ul className="space-y-2">
              {res.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2.5 text-[13px]">
                  {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />}
                  <span className="min-w-0">
                    <span className="font-medium text-fg">{c.name}</span>
                    <span className="block truncate font-mono text-[11.5px] text-mute">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="grid gap-2 text-[12.5px] sm:grid-cols-3">
              <div className="rounded-lg border border-line bg-soft p-2.5">
                <p className="text-mute">Receipt</p>
                <Hash value={res.receiptId} head={6} tail={4} />
              </div>
              <div className="rounded-lg border border-line bg-soft p-2.5">
                <p className="text-mute">Block</p>
                <Hash value={res.block.hash} head={6} tail={4} />
              </div>
              <div className="rounded-lg border border-line bg-soft p-2.5">
                <p className="text-mute">Approved stake</p>
                <p className="font-mono text-fg">{((Number(BigInt(res.head.approvedStake) * 10000n / BigInt(res.head.totalStake || '1')) / 100)).toFixed(1)}%</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

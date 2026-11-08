'use client';

import { useEffect, useState } from 'react';
import { CONTRACTS } from '@/lib/config';
import { indexer, reader } from '@/lib/client';
import { formatCount } from '@/lib/format';

interface Stats {
  schemas: number | null;
  attestations: number | null;
  authorities: number | null;
  agents: number | null;
}

/** Live protocol numbers: the indexer when it answers, the contracts' own counters otherwise. */
export function LiveStats({ className = '' }: { className?: string }) {
  const [s, setS] = useState<Stats | null>(null);
  const [source, setSource] = useState<'indexer' | 'chain' | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const st = await indexer.stats();
        if (alive) {
          setS({ schemas: st.schemas, attestations: st.attestations, authorities: st.authorities, agents: st.agents });
          setSource('indexer');
        }
      } catch {
        try {
          const c = reader();
          const [schemas, attestations] = await Promise.all([c.view<number>(CONTRACTS.schemas, 'schema_count'), c.view<number>(CONTRACTS.attestations, 'attestation_count')]);
          if (alive) {
            setS({ schemas, attestations, authorities: null, agents: null });
            setSource('chain');
          }
        } catch {
          if (alive) setSource(null);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const items: Array<[string, number | null | undefined]> = [
    ['Schemas', s?.schemas],
    ['Attestations', s?.attestations],
    ['Authorities', s?.authorities],
    ['Agents', s?.agents],
  ];
  return (
    <div className={className}>
      <dl className="grid grid-cols-2 divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-panel sm:grid-cols-4 sm:divide-x">
        {items.map(([label, v], i) => (
          <div key={label} className={`px-5 py-4 ${i < 2 ? 'border-b border-line sm:border-b-0' : ''} ${i % 2 === 0 ? 'border-r border-line sm:border-r-0' : ''}`}>
            <dt className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-mute">{label}</dt>
            <dd className="mt-1 font-display text-2xl font-semibold tabular-nums text-fg">{s === null ? <span className="skeleton inline-block h-7 w-12 rounded-md align-middle" /> : v === null || v === undefined ? 'n/a' : formatCount(v)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-right text-[11.5px] text-mute">{source === 'indexer' ? 'Live from the indexer' : source === 'chain' ? 'Read from the contracts (indexer offline)' : s === null ? 'Reading NEAR testnet' : 'NEAR testnet unreachable'}</p>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { CONTRACTS, NETWORK } from '@/lib/config';
import { indexer, reader } from '@/lib/client';
import { formatCount } from '@/lib/format';
import { CountUp } from './Motion';

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
          if (alive) setS({ schemas: null, attestations: null, authorities: null, agents: null });
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
      <dl className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-panel shadow-panel sm:grid-cols-4">
        {items.map(([label, v], i) => (
          // Two by two on phones, one row from sm: every cell but the row's last gets a right border.
          <div key={label} className={`border-line px-5 py-5 ${i < 2 ? 'border-b sm:border-b-0' : ''} ${i % 2 === 0 ? 'border-r' : ''} ${i < 3 ? 'sm:border-r' : ''}`}>
            <dt className="text-[13px] text-mute">{label}</dt>
            <dd className="mt-1.5 font-display text-[1.6rem] font-semibold leading-8 tabular-nums text-fg">{s === null ? <span className="skeleton inline-block h-6 w-12 rounded align-middle" /> : v === null || v === undefined ? <span className="text-mute">n/a</span> : <CountUp value={v} format={formatCount} />}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2.5 text-right text-[12px] text-mute">{source === 'indexer' ? 'Live from the indexer' : source === 'chain' ? 'Read from the contracts (indexer offline)' : s === null ? `Reading NEAR ${NETWORK}` : 'Unavailable: the indexer and the contracts did not answer'}</p>
    </div>
  );
}

import { knownSchemaUid } from '@attestra/sdk';
import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { CONTRACTS, NETWORK } from '@/lib/config';
import { truncate } from '@/lib/format';
import { Badge } from '../ui/primitives';

/**
 * A real testnet attestation: a private age check that ran in NEAR OutLayer's TEE on 2026-11-10
 * (transaction FRoM2PTuCZ4wcWvLPnCR9tAd6TasuERH1Q8QAdX8SHr1). Its values are copied from the chain.
 */
const UID = 'b977586c3a55c81ebfcd2c6ee4e64a162cfc7877ed8a9820d0648676177118d9';
const EVIDENCE = '6508e75d7d1a10e9503d038b808acae34a5401ee12c1f223ec9b8384033b0f91';
const LIVE = NETWORK === 'testnet';

/** The decoded data of a Private AI check (the aiCheck schema), field by field. */
const DATA: Array<[field: string, value: string, kind: 's' | 'k' | 'n']> = [
  ['rule_id', '"age_over_18"', 's'],
  ['claim', '"is at least 18 years old"', 's'],
  ['result', 'true', 'k'],
  ['evidence_hash', `0x${truncate(EVIDENCE, 6, 6)}`, 'n'],
  ['model', '"z-ai/glm-5.3-flash"', 's'],
];

/**
 * The hero's product artefact: one attestation record as the explorer shows it, with its decoded data,
 * its finality and the SDK call that proves it. Sample values in the real shapes.
 */
export function HeroVisual() {
  const schemaUid = knownSchemaUid('aiCheck');
  const rows: Array<[string, React.ReactNode]> = [
    [
      'Schema',
      <span key="s" className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-fg">Private AI check</span>
        <span className="truncate font-mono text-[11.5px] text-mute">{truncate(schemaUid, 6, 4)}</span>
      </span>,
    ],
    ['Attester', <span key="a" className="block truncate font-mono text-[12.5px] text-fg">{CONTRACTS.verdicts}</span>],
    ['Subject', <span key="b" className="block truncate font-mono text-[12.5px] text-fg">attestra.testnet</span>],
    ['Issued', <span key="i" className="text-fg">Nov 10, 2026, 16:58 UTC</span>],
    ['Expires', <span key="e" className="text-fg">Nov 10, 2027, 16:58 UTC</span>],
  ];

  return (
    <figure className="w-full max-w-[520px] lg:ml-auto">
      <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-float">
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-mute">Attestation</p>
            <p className="mt-0.5 truncate font-mono text-[13px] text-fg" title={UID}>
              {truncate(UID, 10, 8)}
            </p>
          </div>
          <Badge tone="ok" className="mt-0.5 shrink-0">
            active
          </Badge>
        </div>

        <dl className="px-4 sm:px-5">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3 border-b border-line py-2.5 last:border-b-0 text-[13px] sm:grid-cols-[116px_minmax(0,1fr)]">
              <dt className="text-mute">{label}</dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="border-y border-line bg-panel-2 px-4 py-3.5 sm:px-5">
          <p className="text-[12px] font-medium text-mute">Data, decoded from Borsh</p>
          <dl className="mt-2 space-y-1 font-mono text-[11.5px] sm:text-[12px]">
            {DATA.map(([field, value, kind]) => (
              <div key={field} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 sm:grid-cols-[116px_minmax(0,1fr)]">
                <dt className="text-mute">{field}</dt>
                <dd className={`truncate ${kind === 's' ? 'text-fg' : kind === 'k' ? 'text-emerald-700 dark:text-emerald-400' : 'text-soft'}`} title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5">
          <p className="flex items-center gap-2 text-[13px] font-medium text-fg">
            <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            Final on NEAR testnet
          </p>
          <p className="font-mono text-[11.5px] text-mute">block 277,095,095</p>
        </div>

        <pre className="overflow-x-auto border-t border-ink-800 bg-[#100e0c] px-4 py-3 text-[11px] leading-[1.75] text-stone-200 sm:px-5 sm:text-[12px] dark:border-line">
          <code>
            <span className="tok-k">const</span> r = <span className="tok-k">await</span> client.<span className="tok-f">proveAttestation</span>(uid);
            {'\n'}r.data.verified; <span className="tok-c">{'// true'}</span>
          </code>
        </pre>
      </div>
      <figcaption className="mt-3 text-[12px] text-mute lg:text-right">
        {LIVE ? (
          <>
            A private check on testnet, decided in NEAR OutLayer&apos;s TEE.{' '}
            <Link href={`/attestations/${UID}`} className="text-soft underline decoration-[var(--line-strong)] underline-offset-4 hover:text-fg">
              Open it in the explorer
            </Link>
          </>
        ) : (
          'An example record from testnet, in the shape the explorer shows.'
        )}
      </figcaption>
    </figure>
  );
}

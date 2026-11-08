'use client';

import { useState } from 'react';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { SchemaUidInput } from '@/components/sandbox/SchemaUidInput';
import { need } from '@/components/sandbox/need';
import { Label, Toggle } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { reader } from '@/lib/client';
import { CONTRACTS } from '@/lib/config';

const CHOICES = [
  [CONTRACTS.resolvers.whitelist, 'Whitelist'],
  [CONTRACTS.resolvers.fee, 'Fee'],
  [CONTRACTS.resolvers.tokenGated, 'Token gated'],
  [CONTRACTS.resolvers.tokenReward, 'Token reward'],
] as const;

export default function Pipeline() {
  const w = useWallet();
  const [schema, setSchema] = useState('');
  const [chosen, setChosen] = useState<string[]>([CONTRACTS.resolvers.whitelist, CONTRACTS.resolvers.fee]);
  return (
    <ToolFrame
      slug="cross-contract"
      notes={
        <>
          <p>Register a schema with resolver <code>{CONTRACTS.resolvers.pipeline}</code>, then choose which resolvers run, in order.</p>
          <p>Each step is a cross-contract call. If a step refuses, every earlier step is told to undo (a charged fee is refunded) and the attestation is rolled back.</p>
        </>
      }
    >
      <ActionCard title="Set the pipeline" label="Save pipeline" disabled={!schema || chosen.length === 0} action={() => need(w.client).pipelineSetResolvers(schema, chosen)}>
        <SchemaUidInput value={schema} onChange={setSchema} />
        <div>
          <Label>Steps, in the order you tick them</Label>
          <div className="flex flex-wrap gap-4">
            {CHOICES.map(([id, label]) => (
              <Toggle key={id} checked={chosen.includes(id)} onChange={(on) => setChosen((c) => (on ? [...c, id] : c.filter((x) => x !== id)))} label={label} />
            ))}
          </div>
          <ol className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px]">
            {chosen.map((c, i) => (
              <li key={c} className="flex items-center gap-2">
                <span className="rounded-md border border-line bg-panel-2 px-2 py-1 font-mono">{c.split('.')[0]}</span>
                {i < chosen.length - 1 && <span className="text-accent">then</span>}
              </li>
            ))}
          </ol>
        </div>
      </ActionCard>
      <ActionCard title="Read the pipeline" label="Read" disabled={!schema} action={() => reader().pipelineGetResolvers(schema)} />
    </ToolFrame>
  );
}

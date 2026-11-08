'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { BASE_TYPES, computeSchemaUid } from '@attestra/sdk';
import { ActionCard, ToolFrame, UidResult } from '@/components/sandbox/ToolFrame';
import { need } from '@/components/sandbox/need';
import { Input, Label, Select, Toggle } from '@/components/ui/Field';
import { useWallet } from '@/components/wallet/WalletProvider';
import { CONTRACTS } from '@/lib/config';

const RESOLVERS = [
  ['', 'None'],
  [CONTRACTS.resolvers.whitelist, 'Whitelist'],
  [CONTRACTS.resolvers.fee, 'Fee'],
  [CONTRACTS.resolvers.tokenGated, 'Token gated'],
  [CONTRACTS.resolvers.tokenReward, 'Token reward'],
  [CONTRACTS.resolvers.pipeline, 'Pipeline'],
];

export default function SchemaBuilder() {
  const w = useWallet();
  const [fields, setFields] = useState([{ type: 'string', name: 'name' }, { type: 'u8', name: 'level' }, { type: 'bool', name: 'verified' }]);
  const [revocable, setRevocable] = useState(true);
  const [resolver, setResolver] = useState('');
  const definition = fields.filter((f) => f.name).map((f) => `${f.type} ${f.name}`).join(', ');
  let uid = '';
  try {
    uid = definition ? computeSchemaUid(definition, resolver || null, revocable) : '';
  } catch {
    uid = '';
  }
  return (
    <ToolFrame
      slug="schema-builder"
      notes={
        <>
          <p>The UID is <code>sha256(borsh(tag, definition, resolver, revocable))</code>, computed here before you register and again by the contract.</p>
          <p>With a resolver, the schemas contract first asks it to accept the schema; you become the admin of that schema&apos;s settings on the resolver.</p>
          <p>Storage is paid from your NEP-145 balance on the schemas contract (the SDK tops it up).</p>
        </>
      }
    >
      <ActionCard
        title="Fields"
        subtitle="Borsh types; add [] for a list"
        label="Register schema"
        disabled={!definition}
        action={() => need(w.client).registerSchema({ definition, revocable, resolver: resolver || null })}
        render={(d) => <UidResult uid={d.schemaUid} kind="schemas" />}
      >
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={i} className="flex gap-2">
              <Select aria-label="Type" value={f.type.replace('[]', '')} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: e.target.value + (x.type.endsWith('[]') ? '[]' : '') } : x)))} className="w-40">
                {BASE_TYPES.map((t) => <option key={t}>{t}</option>)}
              </Select>
              <label className="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] text-soft">
                <input type="checkbox" checked={f.type.endsWith('[]')} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: x.type.replace('[]', '') + (e.target.checked ? '[]' : '') } : x)))} /> list
              </label>
              <Input aria-label="Field name" value={f.name} placeholder="field_name" onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, '') } : x)))} />
              <button type="button" aria-label="Remove field" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} className="grid size-10 shrink-0 place-items-center rounded-lg border border-line text-mute hover:text-red-500">
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setFields((fs) => [...fs, { type: 'string', name: '' }])} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 py-1.5 text-[13px] text-soft hover:border-brand-400 hover:text-accent">
            <Plus className="size-3.5" /> Add field
          </button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="resolver">Resolver</Label>
            <Select id="resolver" value={resolver} onChange={(e) => setResolver(e.target.value)}>
              {RESOLVERS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
            </Select>
          </div>
          <div className="flex items-end pb-2">
            <Toggle checked={revocable} onChange={setRevocable} label="Attestations can be revoked" />
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel-2 p-3 text-[12.5px]">
          <p className="text-mute">Definition</p>
          <p className="break-all font-mono text-fg">{definition || 'add a field'}</p>
          <p className="mt-2 text-mute">UID</p>
          <p className="break-all font-mono text-accent">{uid}</p>
        </div>
      </ActionCard>
    </ToolFrame>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { SchemaEncoder } from 'attestra';
import { ToolFrame } from '@/components/sandbox/ToolFrame';
import { SchemaValues } from '@/components/sandbox/SchemaFields';
import { CopyButton } from '@/components/ui/Copy';
import { Input, Label, Textarea } from '@/components/ui/Field';
import { Panel, PanelHeader } from '@/components/ui/primitives';

export default function Encoder() {
  const [def, setDef] = useState('string name, u8 level, bool verified, string[] tags');
  const [encoded, setEncoded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const decoded = useMemo(() => {
    if (!raw.trim()) return null;
    try {
      return JSON.stringify(new SchemaEncoder(def).decode(raw.trim()), null, 2);
    } catch (e) {
      return `Cannot decode: ${(e as Error).message}`;
    }
  }, [raw, def]);
  let defErr: string | null = null;
  try {
    new SchemaEncoder(def);
  } catch (e) {
    defErr = (e as Error).message;
  }
  return (
    <ToolFrame slug="schema-encoder" notes={<><p>Data is the Borsh encoding of the fields in order: strings and lists carry a u32 length, integers are little endian, bytes32 is raw.</p><p>A Rust contract decodes it with <code>borsh::from_slice</code>.</p></>}>
      <Panel>
        <PanelHeader title="Definition" />
        <div className="space-y-4 p-5">
          <div>
            <Label htmlFor="def" hint={defErr ?? 'valid'}>Fields</Label>
            <Input id="def" className="font-mono text-[12.5px]" value={def} onChange={(e) => setDef(e.target.value)} />
          </div>
          {!defErr && <SchemaValues definition={def} onEncoded={(d, e) => (setEncoded(d), setErr(e))} />}
          <div className="rounded-xl border border-line bg-panel-2 p-3">
            <div className="flex items-center justify-between">
              <p className="text-[12.5px] text-mute">Encoded (base64)</p>
              {encoded && <CopyButton value={encoded} />}
            </div>
            <p className="mt-1 break-all font-mono text-[12.5px] text-accent">{encoded ?? err ?? ''}</p>
          </div>
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Decode" subtitle="Paste base64 data from any attestation" />
        <div className="space-y-3 p-5">
          <Textarea aria-label="Base64 data" rows={3} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="AwAAAEJvYgMBAgAAAA..." />
          {decoded && <pre className="overflow-auto rounded-lg border border-line bg-panel-2 p-3 font-mono text-[12px] text-fg">{decoded}</pre>}
        </div>
      </Panel>
    </ToolFrame>
  );
}

'use client';

import { useState } from 'react';
import { SchemaEncoder, type ServiceResponse } from '@attestra/sdk';
import { ActionCard, ToolFrame } from '@/components/sandbox/ToolFrame';
import { Input, Label } from '@/components/ui/Field';
import { reader } from '@/lib/client';

export default function Lookup() {
  const [uid, setUid] = useState('');
  return (
    <ToolFrame slug="lookup" notes={<p>Reads straight from the contracts with a view call: no indexer involved. A UID is tried as an attestation, then as a schema.</p>}>
      <ActionCard
        title="Read from the chain"
        label="Look up"
        disabled={!uid}
        action={async (): Promise<ServiceResponse<Record<string, unknown>>> => {
          const c = reader();
          const a = await c.getAttestation(uid.trim());
          if (a.success && a.data) {
            const s = await c.getSchema(a.data.schema_uid);
            let decoded = null;
            try {
              decoded = s.data ? new SchemaEncoder(s.data.definition).decode(a.data.data) : null;
            } catch {
              decoded = null;
            }
            return { success: true, data: { kind: 'attestation', ...a.data, decoded } };
          }
          const s = await c.getSchema(uid.trim());
          if (s.success && s.data) return { success: true, data: { kind: 'schema', ...s.data } };
          return { success: false, error: { type: 'NOT_FOUND' as never, message: 'no attestation or schema with this UID' } };
        }}
      >
        <div>
          <Label htmlFor="uid">UID</Label>
          <Input id="uid" className="font-mono text-[12.5px]" value={uid} onChange={(e) => setUid(e.target.value)} />
        </div>
      </ActionCard>
    </ToolFrame>
  );
}

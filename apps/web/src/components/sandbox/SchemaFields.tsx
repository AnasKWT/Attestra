'use client';

import { useEffect, useMemo, useState } from 'react';
import { KNOWN_SCHEMAS, SchemaEncoder, knownSchemaUid, parseSchema } from '@attestra/sdk';
import { reader } from '@/lib/client';
import { Input, Label, Select, Textarea } from '../ui/Field';

/** Picks a schema: a well-known one, or any UID (its definition is read from the chain). */
export function SchemaPicker({ value, onChange, onDefinition }: { value: string; onChange: (uid: string) => void; onDefinition: (def: string | null) => void }) {
  const known = useMemo(() => Object.entries(KNOWN_SCHEMAS).map(([k, s]) => ({ key: k, uid: knownSchemaUid(k as keyof typeof KNOWN_SCHEMAS), name: s.name })), []);
  const [status, setStatus] = useState('');
  useEffect(() => {
    const uid = value.trim().replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(uid)) {
      onDefinition(null);
      setStatus(uid ? 'a UID is 64 hex characters' : '');
      return;
    }
    let alive = true;
    setStatus('reading the schema...');
    reader()
      .getSchema(uid)
      .then((r) => {
        if (!alive) return;
        if (r.success && r.data) {
          onDefinition(r.data.definition);
          setStatus(r.data.resolver ? `resolver: ${r.data.resolver}` : r.data.revocable ? 'revocable' : 'not revocable');
        } else {
          onDefinition(null);
          setStatus('not found on chain');
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div>
      <Label htmlFor="schema" hint={status}>Schema</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select aria-label="Well-known schemas" value={known.find((k) => k.uid === value)?.uid ?? ''} onChange={(e) => e.target.value && onChange(e.target.value)} className="sm:w-56">
          <option value="">Pick a well-known schema</option>
          {known.map((k) => (
            <option key={k.key} value={k.uid}>
              {k.name}
            </option>
          ))}
        </Select>
        <Input id="schema" placeholder="or paste a schema UID" value={value} onChange={(e) => onChange(e.target.value.trim())} className="font-mono text-[12.5px]" />
      </div>
    </div>
  );
}

function inputFor(type: string): 'bool' | 'list' | 'text' {
  if (type === 'bool') return 'bool';
  if (type.endsWith('[]')) return 'list';
  return 'text';
}

/** Inputs for each field of a definition; reports the encoded base64 (or an error). */
export function SchemaValues({ definition, onEncoded }: { definition: string; onEncoded: (data: string | null, error: string | null) => void }) {
  const fields = useMemo(() => {
    try {
      return parseSchema(definition);
    } catch {
      return [];
    }
  }, [definition]);
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    setVals(Object.fromEntries(fields.map((f) => [f.name, f.type === 'bool' ? 'true' : ''])));
  }, [fields]);
  useEffect(() => {
    try {
      const enc = new SchemaEncoder(definition);
      const values: Record<string, unknown> = {};
      for (const f of fields) {
        const raw = vals[f.name] ?? '';
        if (f.type === 'bool') values[f.name] = raw === 'true';
        else if (f.type.endsWith('[]')) {
          const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
          values[f.name] = /^(u|i)(8|16|32)\[\]$/.test(f.type) ? items.map(Number) : items;
        } else if (/^(u|i)(8|16|32)$/.test(f.type)) values[f.name] = raw === '' ? 0 : Number(raw);
        else if (/^(u|i)(64|128)$/.test(f.type)) values[f.name] = raw === '' ? '0' : raw;
        else values[f.name] = raw;
      }
      onEncoded(enc.encode(values), null);
    } catch (e) {
      onEncoded(null, (e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals, definition]);
  if (fields.length === 0) return null;
  return (
    <div className="grid gap-3 rounded-xl border border-line bg-panel-2 p-4 sm:grid-cols-2">
      {fields.map((f) => (
        <div key={f.name} className={inputFor(f.type) === 'list' ? 'sm:col-span-2' : ''}>
          <Label htmlFor={`f-${f.name}`} hint={f.type}>{f.name}</Label>
          {inputFor(f.type) === 'bool' ? (
            <Select id={`f-${f.name}`} value={vals[f.name] ?? 'true'} onChange={(e) => setVals((v) => ({ ...v, [f.name]: e.target.value }))}>
              <option value="true">true</option>
              <option value="false">false</option>
            </Select>
          ) : (
            <Input id={`f-${f.name}`} value={vals[f.name] ?? ''} placeholder={f.type.endsWith('[]') ? 'comma, separated, values' : f.type === 'bytes32' ? '64 hex characters' : f.type} onChange={(e) => setVals((v) => ({ ...v, [f.name]: e.target.value }))} />
          )}
        </div>
      ))}
    </div>
  );
}

export function JsonArea({ value, onChange, rows = 6, id }: { value: string; onChange: (v: string) => void; rows?: number; id?: string }) {
  return <Textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
}

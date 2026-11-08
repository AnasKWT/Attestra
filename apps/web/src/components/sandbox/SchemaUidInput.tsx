'use client';

import { Input, Label } from '../ui/Field';

export function SchemaUidInput({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <Label htmlFor="suid" hint={hint ?? 'a schema registered with this resolver; you are its admin'}>Schema UID</Label>
      <Input id="suid" className="font-mono text-[12.5px]" value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="64 hex characters" />
    </div>
  );
}

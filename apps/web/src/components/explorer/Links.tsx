import Link from 'next/link';
import { shortAccount, truncate } from '@/lib/format';

export function AccountLink({ id, className = '' }: { id: string; className?: string }) {
  const caip = id.includes(':');
  return (
    <Link href={`/accounts/${encodeURIComponent(id)}`} title={id} className={`whitespace-nowrap font-mono text-[12.5px] text-fg underline-offset-4 hover:text-accent hover:underline ${className}`}>
      {caip ? truncate(id, 14, 6) : shortAccount(id)}
    </Link>
  );
}

export function UidLink({ uid, kind }: { uid: string; kind: 'attestations' | 'schemas' }) {
  return (
    <Link href={`/${kind}/${uid}`} title={uid} className="font-mono text-[12.5px] text-fg underline-offset-4 hover:text-accent hover:underline">
      {truncate(uid, 8, 6)}
    </Link>
  );
}

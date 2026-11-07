'use client';

import { ChevronDown, Fingerprint, LogOut, User, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { shortAccount } from '@/lib/format';
import { buttonClass } from '../ui/primitives';
import { useWallet } from './WalletProvider';

export function ConnectButton({ compact = false }: { compact?: boolean }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (w.accountId) {
    return (
      <div ref={ref} className="relative">
        <button onClick={() => setOpen((o) => !o)} className={buttonClass('secondary', 'sm', 'max-w-[220px]')} aria-haspopup="menu" aria-expanded={open}>
          <span className="size-2 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" />
          <span className="truncate font-mono text-[12.5px]">{shortAccount(w.accountId)}</span>
          <ChevronDown className="size-3.5 shrink-0 text-mute" />
        </button>
        {open && (
          <div role="menu" className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-panel p-1 shadow-float">
            <div className="px-3 py-2 text-[12px] text-mute">Signed in with {w.kind === 'passkey' ? 'a passkey' : 'a NEAR wallet'}</div>
            <Link href="/profile" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13.5px] text-fg hover:bg-soft">
              <User className="size-4 text-mute" /> Profile and credentials
            </Link>
            <button onClick={() => void w.signOut()} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13.5px] text-fg hover:bg-soft">
              <LogOut className="size-4 text-mute" /> Sign out
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} disabled={w.busy} className={buttonClass('primary', 'sm')} aria-haspopup="menu" aria-expanded={open}>
        <Wallet className="size-4" />
        {compact ? 'Sign in' : w.busy ? 'Connecting' : 'Sign in'}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-xl border border-line bg-panel p-1.5 shadow-float">
          <button
            onClick={() => {
              setOpen(false);
              void w.connectWallet();
            }}
            className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-soft"
          >
            <Wallet className="mt-0.5 size-4 text-accent" />
            <span>
              <span className="block text-[13.5px] font-medium text-fg">NEAR wallet</span>
              <span className="block text-[12px] text-mute">HOT, Meteor, Intear, MyNearWallet and more</span>
            </span>
          </button>
          <button
            onClick={() => {
              setOpen(false);
              void w.signInPasskey();
            }}
            className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-soft"
          >
            <Fingerprint className="mt-0.5 size-4 text-accent" />
            <span>
              <span className="block text-[13.5px] font-medium text-fg">Passkey</span>
              <span className="block text-[12px] text-mute">Face ID, Touch ID or a security key. No wallet needed.</span>
            </span>
          </button>
          <button
            onClick={() => {
              setOpen(false);
              void w.createPasskey();
            }}
            className="mt-1 w-full rounded-lg border border-dashed border-line-strong px-3 py-2 text-[12.5px] text-soft hover:border-brand-400 hover:text-accent"
          >
            New here? Create a passkey account
          </button>
        </div>
      )}
      {w.error && <p className="absolute right-0 mt-2 w-72 rounded-lg border border-red-500/25 bg-panel px-3 py-2 text-[12px] text-red-600 shadow-panel dark:text-red-400">{w.error}</p>}
    </div>
  );
}

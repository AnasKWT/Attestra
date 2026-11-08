'use client';

import { CheckCircle2, ExternalLink, Info, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { ServiceResponse } from '@attestra/sdk';
import { txUrl } from '@/lib/config';
import { toolBySlug } from '@/lib/tools';
import { ConnectButton } from '../wallet/ConnectButton';
import { useWallet } from '../wallet/WalletProvider';
import { CopyButton } from '../ui/Copy';
import { Badge, Button, Panel, PanelHeader } from '../ui/primitives';

export function ToolFrame({ slug, children, notes, aside }: { slug: string; children: ReactNode; notes?: ReactNode; aside?: ReactNode }) {
  const t = toolBySlug(slug);
  const w = useWallet();
  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="brand">{t?.group}</Badge>
          {t?.write ? <Badge tone="warn">sends a testnet transaction</Badge> : <Badge tone="ok">read only</Badge>}
        </div>
        <h1 className="mt-3 text-2xl font-semibold text-fg sm:text-[1.9rem]">{t?.title}</h1>
        <p className="mt-1.5 max-w-2xl text-[14.5px] text-soft">{t?.blurb}</p>
      </div>
      {t?.write && !w.accountId && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-500/25 bg-accent-soft px-4 py-3 text-[13.5px] text-fg">
          <span>Sign in with a NEAR wallet or a passkey to send transactions. Reads work without signing in.</span>
          <ConnectButton />
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-6">{children}</div>
        <div className="space-y-6">
          {notes && (
            <Panel>
              <PanelHeader icon={<Info className="size-4" />} title="How it works" />
              <div className="space-y-2.5 px-5 py-4 text-[13px] leading-relaxed text-soft [&_code]:rounded [&_code]:bg-soft [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-fg">{notes}</div>
            </Panel>
          )}
          {aside}
        </div>
      </div>
    </div>
  );
}

/** A form card with a submit button that runs an SDK call and shows its result. */
export function ActionCard<T>({
  title,
  subtitle,
  children,
  action,
  label,
  disabled,
  render,
  icon,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  action: () => Promise<ServiceResponse<T>>;
  label: string;
  disabled?: boolean;
  render?: (data: T) => ReactNode;
  icon?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ServiceResponse<T> | null>(null);
  return (
    <Panel>
      <PanelHeader title={title} subtitle={subtitle} icon={icon} />
      <form
        className="space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setRes(null);
          try {
            setRes(await action());
          } catch (err) {
            setRes({ success: false, error: { type: 'VALIDATION_ERROR' as never, message: (err as Error).message } });
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || disabled}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {label}
          </Button>
        </div>
        {res && <Result res={res} render={render} />}
      </form>
    </Panel>
  );
}

export function Result<T>({ res, render }: { res: ServiceResponse<T>; render?: (data: T) => ReactNode }) {
  if (!res.success) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-700 dark:text-red-400">
        <XCircle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold">{res.error?.type.replaceAll('_', ' ').toLowerCase()}</p>
          <p className="mt-0.5 break-words">{res.error?.message}</p>
        </div>
      </div>
    );
  }
  const json = JSON.stringify(res.data ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  return (
    <div className="overflow-hidden rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06]">
      <div className="flex items-center justify-between gap-2 border-b border-emerald-500/15 px-4 py-2.5">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="size-4" /> Done
        </span>
        {res.txHash && (
          <a href={txUrl(res.txHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[12px] text-soft hover:text-accent">
            {res.txHash.slice(0, 10)}... <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <div className="p-4">
        {render && res.data !== undefined ? render(res.data as T) : null}
        {(!render || res.data === undefined) && (
          <div className="relative">
            <pre className="max-h-80 overflow-auto rounded-lg bg-panel p-3 font-mono text-[12px] leading-relaxed text-fg">{json}</pre>
            <CopyButton value={json} className="absolute right-2 top-2" />
          </div>
        )}
      </div>
    </div>
  );
}

export function UidResult({ uid, kind }: { uid: string; kind: 'attestations' | 'schemas' }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="text-soft">{kind === 'schemas' ? 'Schema' : 'Attestation'} UID</span>
      <code className="break-all font-mono text-[12px] text-fg">{uid}</code>
      <CopyButton value={uid} />
      <Link href={`/${kind}/${uid}`} className="text-accent hover:underline">
        Open in the explorer
      </Link>
    </div>
  );
}

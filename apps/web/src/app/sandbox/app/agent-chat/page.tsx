'use client';

import { ArrowUp, Bot, ExternalLink, Loader2, ShieldCheck, User, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ToolFrame } from '@/components/sandbox/ToolFrame';
import { Badge, Panel } from '@/components/ui/primitives';
import { AGENT_URL } from '@/lib/config';
import { readableError } from '@/lib/useFetch';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  tools?: string[];
  verification?: { model: string; chat_id: string; verified: boolean | null; verify_url: string; signing_address?: string };
}

const STARTERS = ['What schemas are registered?', 'Is attestation <uid> still valid?', 'Show the reputation of research-agent.testnet', 'Prove the newest attestation is final'];

export default function AgentChat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs, busy]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const next = [...msgs, { role: 'user' as const, content: text.trim() }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${AGENT_URL}/v1/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: next.map((m) => ({ role: m.role, content: m.content })) }) });
      const body = (await res.json()) as { reply?: string; tools?: string[]; verification?: Msg['verification']; error?: string };
      if (!res.ok || !body.reply) throw new Error(body.error ?? `the agent answered ${res.status}`);
      setMsgs([...next, { role: 'assistant', content: body.reply, tools: body.tools, verification: body.verification }]);
    } catch (e) {
      setErr(readableError((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToolFrame
      slug="agent-chat"
      notes={
        <>
          <p>The Attestra agent runs on NEAR AI Cloud with a <code>verifiable: true</code> model: inference happens in a TEE and every answer is signed.</p>
          <p>It calls the same read tools as the MCP server (schemas, attestations, authorities, agent reputation, light client proofs).</p>
          <p>Each answer links to its signature at the NEAR AI verification center.</p>
        </>
      }
    >
      <Panel className="flex h-[600px] flex-col overflow-hidden">
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {msgs.length === 0 && (
            <div className="grid h-full place-items-center">
              <div className="max-w-md text-center">
                <p className="font-display text-lg font-semibold text-fg">Ask Attestra</p>
                <p className="mt-1 text-[13.5px] text-mute">Natural language over the whole protocol, answered by a verifiable model.</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {STARTERS.map((s) => (
                    <button key={s} onClick={() => setInput(s)} className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px] text-soft transition-colors hover:border-line-strong hover:text-fg">{s}</button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : ''}`}>
              {m.role === 'assistant' && <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-soft text-soft"><Bot className="size-4" /></span>}
              <div className={`max-w-[80%] rounded-xl px-4 py-3 text-[14px] leading-relaxed ${m.role === 'user' ? 'bg-ink-900 text-white dark:bg-ink-200 dark:text-ink-950' : 'border border-line bg-panel-2 text-fg'}`}>
                <p className="whitespace-pre-wrap break-words">{m.content}</p>
                {m.tools && m.tools.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.tools.map((t, j) => <Badge key={j}><Wrench className="size-3" />{t}</Badge>)}
                  </div>
                )}
                {m.verification && (
                  <a href={m.verification.verify_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-emerald-600 hover:underline dark:text-emerald-400">
                    <ShieldCheck className="size-3.5" />
                    {m.verification.verified ? 'signature verified' : 'signed'} by {m.verification.model} <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
              {m.role === 'user' && <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-panel text-mute"><User className="size-4" /></span>}
            </div>
          ))}
          {busy && <div className="flex items-center gap-2 text-[13px] text-mute"><Loader2 className="size-4 animate-spin" /> Thinking in the TEE...</div>}
          {err && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-400">{err}</p>}
          <div ref={end} />
        </div>
        <form onSubmit={(e) => (e.preventDefault(), void send(input))} className="flex items-end gap-2 border-t border-line bg-panel p-3">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} rows={1} placeholder="Ask about schemas, attestations, agents..." aria-label="Message" className="max-h-32 min-h-11 flex-1 resize-none rounded-lg border border-line-strong bg-panel-2 px-3.5 py-2.5 text-[14px] text-fg outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15" />
          <button type="submit" disabled={busy || !input.trim()} aria-label="Send" className="grid size-11 place-items-center rounded-lg bg-brand-600 text-white transition-colors hover:bg-brand-700 disabled:opacity-40"><ArrowUp className="size-5" /></button>
        </form>
      </Panel>
    </ToolFrame>
  );
}

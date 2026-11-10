'use client';

import { Badge } from '@/components/ui/primitives';
import { AGENT_URL } from '@/lib/config';
import { useAsync } from '@/lib/useFetch';

export type CheckerModeName = 'local' | 'outlayer';

/** Reads which checker the agent runs from its /health (checker.mode). */
async function readMode(): Promise<CheckerModeName | null> {
  const res = await fetch(`${AGENT_URL}/health`, { cache: 'no-store' });
  const body = (await res.json()) as { checker?: { mode?: unknown } };
  const mode = body.checker?.mode;
  return mode === 'local' || mode === 'outlayer' ? mode : null;
}

export function useCheckerMode() {
  return useAsync(readMode, []);
}

const LABEL: Record<CheckerModeName, string> = {
  outlayer: 'Live: OutLayer TEE',
  local: 'Live: local mode (bootstrap key)',
};

/** A badge with the checker mode the agent reports right now. */
export function CheckerModeBadge() {
  const m = useCheckerMode();
  if (m.loading) return <Badge>checking the agent</Badge>;
  if (!m.data) return <Badge tone="warn">checker mode unknown: the agent did not answer</Badge>;
  return (
    <Badge tone={m.data === 'outlayer' ? 'ok' : 'warn'} dot>
      {LABEL[m.data]}
    </Badge>
  );
}

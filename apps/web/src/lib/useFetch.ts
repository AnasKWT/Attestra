'use client';

import { useEffect, useState } from 'react';

/** Runs an async loader when its key changes; exposes data, error and loading (state is set only from the loader's callbacks). */
export function useAsync<T>(load: () => Promise<T>, key: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [tick, setTick] = useState(0);
  const k = JSON.stringify([...key, tick]);
  const [st, setSt] = useState<{ k: string | null; data: T | null; error: string | null }>({ k: null, data: null, error: null });
  useEffect(() => {
    let alive = true;
    load()
      .then((data) => alive && setSt({ k, data, error: null }))
      .catch((e: Error) => alive && setSt({ k, data: null, error: readableError(e.message) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  const current = st.k === k;
  return { data: current ? st.data : null, error: current ? st.error : null, loading: !current, reload: () => setTick((t) => t + 1) };
}

/** Browsers report an unreachable host as a bare "Failed to fetch" (Chrome), "NetworkError..." (Firefox) or "Load failed" (Safari). */
export function readableError(message: string): string {
  if (isRateLimited(message)) {
    // The Attestra services explain the limit and the wait themselves; anything else gets a plain sentence.
    return /Too Many Requests: .+/.exec(message)?.[0] ?? 'Too Many Requests: the service is limiting requests from this browser for now. Wait a minute, then try again.';
  }
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(message)) return 'Not reachable from this browser.';
  // A view on a contract account that was never created: the deployment is missing, not the record.
  const missing = /account ([\w.-]+) does not exist/i.exec(message);
  if (missing) return `${missing[1]} is not deployed on this network yet, so there is nothing to read.`;
  return message;
}

/** A 429 from a service or an RPC, however the caller worded it. */
export function isRateLimited(message: string): boolean {
  return /\b429\b|Too Many Requests|TOO_MANY_REQUESTS|rate.?limit/i.test(message);
}

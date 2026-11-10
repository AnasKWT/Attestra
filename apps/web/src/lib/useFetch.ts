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
      .catch((e: Error) => alive && setSt({ k, data: null, error: e.message }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  const current = st.k === k;
  return { data: current ? st.data : null, error: current ? st.error : null, loading: !current, reload: () => setTick((t) => t + 1) };
}

import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, isTransient, withRetry } from '../src/retry';

const noWait = { sleep: async () => {} };
const answer = (status: number, headers: Record<string, string> = {}) => new Response('{}', { status, headers });

describe('withRetry', () => {
  it('retries a transient failure and returns the first success', async () => {
    let n = 0;
    const out = await withRetry(async () => {
      if (++n < 3) throw new Error('fetch failed');
      return 'ok';
    }, noWait);
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('stops at once on a failure that is not transient, such as a contract panic', async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw new Error('Smart contract panicked: only the owner');
      }, noWait),
    ).rejects.toThrow('only the owner');
    expect(n).toBe(1);
  });

  it('gives up after the last try and waits with a growing, jittered backoff', async () => {
    const waits: number[] = [];
    await expect(withRetry(async () => Promise.reject(new Error('ECONNRESET')), { attempts: 4, baseMs: 100, sleep: async (ms) => void waits.push(ms) })).rejects.toThrow('ECONNRESET');
    expect(waits).toHaveLength(3);
    waits.forEach((w, i) => expect(w).toBeLessThanOrEqual(100 * 2 ** i));
  });

  it('classifies rate limits, timeouts and 5xx as transient, and 4xx answers as final', () => {
    for (const m of ['HTTP 429: Too Many Requests', 'RPC x: TOO_MANY_REQUESTS', 'fetch failed', 'answered 503']) expect(isTransient(new Error(m))).toBe(true);
    for (const m of ['answered 404', 'not a UID: zz', 'invalid signature']) expect(isTransient(new Error(m))).toBe(false);
  });
});

describe('fetchWithRetry', () => {
  it('retries a read on 429 and 5xx, honouring Retry-After', async () => {
    const f = vi.fn().mockResolvedValueOnce(answer(429, { 'retry-after': '0' })).mockResolvedValueOnce(answer(502)).mockResolvedValueOnce(answer(200));
    const res = await fetchWithRetry('https://rpc.example', {}, { fetchImpl: f as unknown as typeof fetch, ...noWait });
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('returns a 4xx answer to the caller without retrying', async () => {
    const f = vi.fn().mockResolvedValue(answer(404));
    expect((await fetchWithRetry('https://indexer.example/x', {}, { fetchImpl: f as unknown as typeof fetch, ...noWait })).status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('retries a write only when the server says it did not process it, never after a lost answer', async () => {
    const throttled = vi.fn().mockResolvedValueOnce(answer(503)).mockResolvedValueOnce(answer(200));
    expect((await fetchWithRetry('https://relayer.example/v1/submit', { method: 'POST' }, { write: true, fetchImpl: throttled as unknown as typeof fetch, ...noWait })).status).toBe(200);
    expect(throttled).toHaveBeenCalledTimes(2);

    const lost = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await expect(fetchWithRetry('https://relayer.example/v1/submit', { method: 'POST' }, { write: true, fetchImpl: lost as unknown as typeof fetch, ...noWait })).rejects.toThrow('fetch failed');
    expect(lost).toHaveBeenCalledTimes(1);

    const failed = vi.fn().mockResolvedValue(answer(500));
    expect((await fetchWithRetry('https://relayer.example/v1/submit', { method: 'POST' }, { write: true, fetchImpl: failed as unknown as typeof fetch, ...noWait })).status).toBe(500);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});

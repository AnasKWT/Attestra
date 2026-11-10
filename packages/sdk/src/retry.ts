/**
 * Retries with exponential backoff and full jitter, for the network calls the SDK, the CLI, the agent
 * and the services make. Reads retry on any transient failure; writes and paid calls retry only on
 * answers that say the request was not processed (429, 503), so nothing is sent twice.
 */

export interface RetryOptions {
  /** Total tries, the first included (default 4). */
  attempts?: number;
  /** First backoff in milliseconds (default 400); doubles each try, capped at `maxMs`. */
  baseMs?: number;
  maxMs?: number;
  /** Whether a failure is worth another try (default `isTransient`). */
  retryOn?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** HTTP statuses that mean "try again later": rate limits and an overloaded or restarting upstream. */
export const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
/** The statuses that guarantee the request was not processed, safe to retry for a write. */
export const NOT_PROCESSED_STATUSES = new Set([429, 503]);

/** An HTTP answer worth retrying, with the server's `Retry-After` when it gave one. */
export class RetryableStatus extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly retryAfterMs?: number,
  ) {
    super(`${url} answered ${status}`);
    this.name = 'RetryableStatus';
  }
}

/** A dropped connection, a timeout, a rate limit or a 5xx; never a contract panic or a 4xx. */
export function isTransient(error: unknown): boolean {
  if (error instanceof RetryableStatus) return true;
  const e = error as { name?: string; message?: string; code?: string; cause?: { code?: string } } | null;
  const text = `${e?.name ?? ''} ${e?.message ?? ''} ${e?.code ?? ''} ${e?.cause?.code ?? ''}`;
  return /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|TimeoutError|AbortError|TOO_MANY_REQUESTS|TIMEOUT_ERROR|\b429\b|Too Many Requests|\b50[234]\b/i.test(text);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs `fn` until it succeeds, a failure is not worth retrying, or the tries run out. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const base = opts.baseMs ?? 400;
  const max = opts.maxMs ?? 8_000;
  const retryOn = opts.retryOn ?? isTransient;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt + 1 >= attempts || !retryOn(e)) throw e;
      const hinted = e instanceof RetryableStatus ? e.retryAfterMs : undefined;
      // Full jitter: a random wait up to the backoff, so many clients do not retry in step.
      await sleep(hinted ?? Math.round(Math.random() * Math.min(max, base * 2 ** attempt)));
    }
  }
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const seconds = Number(h);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.min(30_000, Math.max(0, at - Date.now())) : undefined;
}

/**
 * `fetch` that retries. By default it retries network failures and `RETRY_STATUSES`, for reads.
 * With `{ write: true }` it retries only answers in `NOT_PROCESSED_STATUSES`, never a dropped
 * connection, since the server may have acted on a request whose answer was lost.
 */
export async function fetchWithRetry(
  input: string,
  init: RequestInit = {},
  opts: RetryOptions & { write?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const statuses = opts.write ? NOT_PROCESSED_STATUSES : RETRY_STATUSES;
  return withRetry(
    async () => {
      const res = await f(input, init);
      if (statuses.has(res.status)) throw new RetryableStatus(res.status, input, retryAfterMs(res));
      return res;
    },
    { ...opts, retryOn: opts.retryOn ?? (opts.write ? (e) => e instanceof RetryableStatus : isTransient) },
  ).catch((e) => {
    // Out of tries on a retryable status: hand back a response-like failure the caller already handles.
    if (e instanceof RetryableStatus) throw new Error(`${e.url} answered ${e.status} after retries`);
    throw e;
  });
}

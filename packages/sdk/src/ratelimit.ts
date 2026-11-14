/**
 * Rate limits for public endpoints that spend money or load: token buckets keyed by client address
 * or account, and daily budgets per route. State lives in memory and stays bounded: buckets that
 * have refilled are swept, and past `maxKeys` the least recently used key is dropped.
 * `rateLimit` is a Hono middleware that answers 429 with `Retry-After`; it needs no Hono import,
 * so the SDK stays free of server dependencies.
 */

/** `limit` requests per `windowMs`; a limit of 0 turns the limit off. */
export interface Rate {
  limit: number;
  windowMs: number;
}

/** What a limiter decided for one request. */
export interface LimitDecision {
  ok: boolean;
  limit: number;
  /** Requests left after this one. */
  remaining: number;
  /** Seconds until the limit is fully available again (`RateLimit-Reset`). */
  resetSecs: number;
  /** Seconds until this request would pass (`Retry-After`); 0 when it passed. */
  retryAfterSecs: number;
}

export interface Limiter {
  readonly rate: Rate;
  /** The decision `take` would make, without counting anything. */
  peek(key: string, cost?: number): LimitDecision;
  take(key: string, cost?: number): LimitDecision;
  /** Gives back what was taken for a request that did not happen. */
  refund(key: string, cost?: number): void;
  /** Keys held in memory. */
  readonly size: number;
}

export interface LimiterOptions {
  /** Most keys kept; the least recently used goes first (default 10,000). */
  maxKeys?: number;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Reads a rate setting: `5/10m` is 5 per 10 minutes (units s, m, h, d), a bare number keeps the
 * default window, `0` or `off` turns it off, empty or unset keeps the default.
 */
export function parseRate(text: string | undefined, fallback: Rate | string): Rate {
  const base = typeof fallback === 'string' ? parseRate(fallback, { limit: 0, windowMs: 1000 }) : fallback;
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return base;
  if (t === 'off') return { limit: 0, windowMs: base.windowMs };
  const m = /^(\d+)(?:\s*\/\s*(\d*)\s*([smhd]))?$/.exec(t);
  if (!m) throw new Error(`a rate is a count per window such as 5/10m, 200/1d or 0 (off), not "${text}"`);
  const limit = Number(m[1]);
  if (!m[3]) return { limit, windowMs: base.windowMs };
  const windowMs = Number(m[2] || '1') * UNITS[m[3]];
  if (windowMs <= 0) throw new Error(`the window of rate "${text}" must be longer than zero`);
  return { limit, windowMs };
}

/** "5 per 10 minutes", "3 per hour", "200 per day". */
export function describeRate(rate: Rate): string {
  for (const [unit, ms] of [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000], ['second', 1000]] as const) {
    if (rate.windowMs % ms === 0) {
      const n = rate.windowMs / ms;
      return `${rate.limit} per ${n === 1 ? unit : `${n} ${unit}s`}`;
    }
  }
  return `${rate.limit} per ${rate.windowMs} ms`;
}

/** "45 seconds", "7 minutes", "3 hours", "1 day" (rounded up). */
export function duration(secs: number): string {
  const s = Math.max(1, Math.ceil(secs));
  const [n, unit] = s < 120 ? [s, 'second'] : s < 7200 ? [Math.ceil(s / 60), 'minute'] : s < 172_800 ? [Math.ceil(s / 3600), 'hour'] : [Math.ceil(s / 86_400), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

const allowed = (rate: Rate): LimitDecision => ({ ok: true, limit: rate.limit, remaining: Number.MAX_SAFE_INTEGER, resetSecs: 0, retryAfterSecs: 0 });

/** Insertion-ordered map used as an LRU: a touched key moves to the end, the first key is the oldest. */
function touch<V>(map: Map<string, V>, key: string, value: V, maxKeys: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxKeys) map.delete(map.keys().next().value as string);
}

/**
 * A token bucket per key: `limit` tokens that refill evenly over `windowMs`, so a client can burst
 * up to the limit and then gets one request every `windowMs / limit`.
 */
export class TokenBucket implements Limiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly maxKeys: number;
  private readonly now: () => number;
  private sweptAt: number;

  constructor(
    readonly rate: Rate,
    opts: LimiterOptions = {},
  ) {
    this.maxKeys = Math.max(1, opts.maxKeys ?? 10_000);
    this.now = opts.now ?? Date.now;
    this.sweptAt = this.now();
  }

  get size(): number {
    return this.buckets.size;
  }

  private tokens(key: string, now: number): number {
    const b = this.buckets.get(key);
    if (!b) return this.rate.limit;
    return Math.min(this.rate.limit, b.tokens + ((now - b.at) * this.rate.limit) / this.rate.windowMs);
  }

  private decide(tokens: number, cost: number): LimitDecision {
    const { limit, windowMs } = this.rate;
    const msPerToken = windowMs / limit;
    const ok = tokens >= cost;
    const left = ok ? tokens - cost : tokens;
    return {
      ok,
      limit,
      remaining: Math.max(0, Math.floor(left)),
      resetSecs: Math.ceil(((limit - left) * msPerToken) / 1000),
      retryAfterSecs: ok ? 0 : Math.max(1, Math.ceil(((cost - tokens) * msPerToken) / 1000)),
    };
  }

  peek(key: string, cost = 1): LimitDecision {
    if (this.rate.limit <= 0) return allowed(this.rate);
    return this.decide(this.tokens(key, this.now()), cost);
  }

  take(key: string, cost = 1): LimitDecision {
    if (this.rate.limit <= 0) return allowed(this.rate);
    const now = this.now();
    if (now - this.sweptAt >= Math.min(this.rate.windowMs, 600_000)) this.sweep();
    const tokens = this.tokens(key, now);
    const d = this.decide(tokens, cost);
    if (d.ok) touch(this.buckets, key, { tokens: tokens - cost, at: now }, this.maxKeys);
    return d;
  }

  refund(key: string, cost = 1): void {
    if (this.rate.limit <= 0 || !this.buckets.has(key)) return;
    const now = this.now();
    touch(this.buckets, key, { tokens: Math.min(this.rate.limit, this.tokens(key, now) + cost), at: now }, this.maxKeys);
  }

  /** Drops every bucket that has refilled: it behaves exactly like a key never seen. */
  sweep(): void {
    const now = this.now();
    this.sweptAt = now;
    for (const key of [...this.buckets.keys()]) if (this.tokens(key, now) >= this.rate.limit) this.buckets.delete(key);
  }
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const secsToUtcMidnight = (ms: number) => Math.ceil((86_400_000 - (ms % 86_400_000)) / 1000);

/** A budget per key and UTC day (for example one per route): counts reset at midnight UTC. */
export class DailyBudget implements Limiter {
  readonly rate: Rate;
  private readonly used = new Map<string, number>();
  private readonly maxKeys: number;
  private readonly now: () => number;
  private day: string;

  constructor(limit: number, opts: LimiterOptions = {}) {
    this.rate = { limit, windowMs: 86_400_000 };
    this.maxKeys = Math.max(1, opts.maxKeys ?? 10_000);
    this.now = opts.now ?? Date.now;
    this.day = utcDay(this.now());
  }

  get size(): number {
    this.roll();
    return this.used.size;
  }

  private roll(): number {
    const now = this.now();
    const today = utcDay(now);
    if (today !== this.day) {
      this.day = today;
      this.used.clear();
    }
    return now;
  }

  private decide(used: number, cost: number, now: number): LimitDecision {
    const ok = used + cost <= this.rate.limit;
    const reset = secsToUtcMidnight(now);
    return { ok, limit: this.rate.limit, remaining: Math.max(0, this.rate.limit - used - (ok ? cost : 0)), resetSecs: reset, retryAfterSecs: ok ? 0 : reset };
  }

  peek(key: string, cost = 1): LimitDecision {
    if (this.rate.limit <= 0) return allowed(this.rate);
    const now = this.roll();
    return this.decide(this.used.get(key) ?? 0, cost, now);
  }

  take(key: string, cost = 1): LimitDecision {
    if (this.rate.limit <= 0) return allowed(this.rate);
    const now = this.roll();
    const used = this.used.get(key) ?? 0;
    const d = this.decide(used, cost, now);
    if (d.ok) touch(this.used, key, used + cost, this.maxKeys);
    return d;
  }

  refund(key: string, cost = 1): void {
    if (this.rate.limit <= 0) return;
    this.roll();
    const used = this.used.get(key);
    if (used === undefined) return;
    if (used - cost > 0) this.used.set(key, used - cost);
    else this.used.delete(key);
  }
}

/** One limit to apply: the limiter, the key it counts under, and how a refusal names its scope. */
export interface LimitEntry {
  limiter: Limiter;
  key: string;
  /** For the refusal: "from one address", "for this account", "in total". */
  scope?: string;
  /** Names the requests in the refusal when this entry refuses, instead of the caller's name. */
  what?: string;
}

export interface CombinedDecision extends LimitDecision {
  /** The entry that refused, when one did. */
  refused?: LimitEntry;
}

/**
 * Takes from every entry, or from none when any would refuse, so a refused request costs no
 * other limit. The decision reports the tightest limit (or the refusal with the longest wait).
 */
export function takeAll(entries: LimitEntry[], cost = 1): CombinedDecision {
  let refused: { entry: LimitEntry; d: LimitDecision } | undefined;
  for (const entry of entries) {
    const d = entry.limiter.peek(entry.key, cost);
    if (!d.ok && (!refused || d.retryAfterSecs > refused.d.retryAfterSecs)) refused = { entry, d };
  }
  if (refused) return { ...refused.d, refused: refused.entry };
  let tightest: LimitDecision | undefined;
  for (const entry of entries) {
    const d = entry.limiter.take(entry.key, cost);
    if (!tightest || d.remaining < tightest.remaining) tightest = d;
  }
  return tightest ?? { ok: true, limit: 0, remaining: Number.MAX_SAFE_INTEGER, resetSecs: 0, retryAfterSecs: 0 };
}

/** Response headers a browser must be allowed to read (CORS `exposeHeaders`). */
export const RATE_LIMIT_HEADERS = ['Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'];

/** `RateLimit-*` headers for a decision, and `Retry-After` when it refused. */
export function rateLimitHeaders(d: LimitDecision): Record<string, string> {
  if (d.remaining === Number.MAX_SAFE_INTEGER) return {};
  return {
    'RateLimit-Limit': String(d.limit),
    'RateLimit-Remaining': String(d.remaining),
    'RateLimit-Reset': String(d.resetSecs),
    ...(d.ok ? {} : { 'Retry-After': String(d.retryAfterSecs) }),
  };
}

/** "Too Many Requests: private checks are limited to 5 per 10 minutes from one address; try again in 7 minutes." */
export function refusalMessage(what: string, d: CombinedDecision): string {
  const r = d.refused;
  const limit = r ? ` are limited to ${describeRate(r.limiter.rate)}${r.scope ? ` ${r.scope}` : ''}` : ' are rate limited';
  return `Too Many Requests: ${r?.what ?? what}${limit}; try again in ${duration(d.retryAfterSecs)}.`;
}

/** The 429 answer: JSON `{ error, retry_after }` with `Retry-After` and `RateLimit-*` headers. */
export function tooManyRequests(d: CombinedDecision, what: string): Response {
  return new Response(JSON.stringify({ error: refusalMessage(what, d), retry_after: d.retryAfterSecs }), {
    status: 429,
    headers: { 'content-type': 'application/json', ...rateLimitHeaders(d) },
  });
}

/**
 * The key for a client address: an IPv4 address as is, an IPv4-mapped IPv6 address as IPv4, and
 * an IPv6 address by its /64 prefix, since one subscriber usually holds a whole /64.
 */
export function addressKey(ip: string): string {
  let a = ip.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracketed) a = bracketed[1];
  a = a.replace(/%.*$/, '');
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(a);
  if (v4port) return v4port[1];
  if (!a.includes(':')) return a;
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  const halves = a.split('::');
  if (halves.length > 2) return a;
  const groups = (s: string | undefined) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const full = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (full.length !== 8 || full.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a;
  return `${full
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

const looksLikeAddress = (s: string) => s.length > 0 && s.length <= 64 && /^[0-9a-fA-F:.[\]%]+$/.test(s);

/**
 * The client's address key: the first `X-Forwarded-For` hop when `trustProxy` is on (the proxy in
 * front, such as Caddy, replaces any value the client sent), otherwise the connection's address.
 */
export function clientAddress(p: { forwardedFor?: string | null; remote?: string | null; trustProxy: boolean }): string {
  if (p.trustProxy && p.forwardedFor) {
    const first = p.forwardedFor.split(',')[0].trim();
    if (looksLikeAddress(first)) return addressKey(first);
  }
  return p.remote ? addressKey(p.remote) : 'unknown';
}

/** The part of a Hono context the middleware reads; `env.incoming` is `@hono/node-server`'s request. */
export interface RateLimitContext {
  req: { header(name: string): string | undefined; path?: string };
  env?: unknown;
  res: Response;
}

/** The connection's remote address under `@hono/node-server`, or undefined elsewhere. */
export function remoteAddress(c: { env?: unknown }): string | undefined {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}

export interface RateLimitRule {
  limiter: Limiter;
  /** The key to count under; default the client address. Undefined skips this rule for the request. */
  key?: (c: RateLimitContext, address: string) => string | undefined;
  scope?: string;
  /** Names the requests when this rule refuses ("searches"); default the middleware's `what`. */
  what?: string;
}

/**
 * Hono middleware: counts the request against every rule (all or none) and answers 429 when one
 * refuses; otherwise sets `RateLimit-*` headers on the response of the next handler.
 * `what` names the requests in the refusal ("private checks").
 */
export function rateLimit(opts: { what: string; rules: RateLimitRule[]; trustProxy: boolean }) {
  return async (c: RateLimitContext, next: () => Promise<void>): Promise<Response | void> => {
    const address = clientAddress({ forwardedFor: c.req.header('x-forwarded-for'), remote: remoteAddress(c), trustProxy: opts.trustProxy });
    const entries: LimitEntry[] = [];
    for (const rule of opts.rules) {
      const key = rule.key ? rule.key(c, address) : address;
      if (key !== undefined) entries.push({ limiter: rule.limiter, key, what: rule.what, scope: rule.scope ?? (rule.key ? undefined : 'from one address') });
    }
    const d = takeAll(entries);
    if (!d.ok) return tooManyRequests(d, opts.what);
    await next();
    try {
      for (const [k, v] of Object.entries(rateLimitHeaders(d))) c.res.headers.set(k, v);
    } catch {
      // a response with immutable headers (a proxied fetch) keeps its own
    }
  };
}

/** Reads `TRUST_PROXY` (true/false, 1/0, yes/no); unset keeps `fallback`. */
export function trustProxySetting(value: string | undefined, fallback = false): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`TRUST_PROXY must be true or false, not "${value}"`);
}

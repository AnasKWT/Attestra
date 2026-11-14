import { describe, expect, it } from 'vitest';
import {
  DailyBudget,
  TokenBucket,
  addressKey,
  clientAddress,
  describeRate,
  parseRate,
  rateLimit,
  rateLimitHeaders,
  refusalMessage,
  takeAll,
  tooManyRequests,
  trustProxySetting,
  type RateLimitContext,
} from '../src/ratelimit';

/** A clock the test moves by hand. */
function clock(start = Date.parse('2026-11-14T12:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe('TokenBucket', () => {
  it('allows a burst up to the limit, then refuses with the wait until the next token', () => {
    const c = clock();
    const b = new TokenBucket({ limit: 5, windowMs: 600_000 }, { now: c.now });
    for (let i = 0; i < 5; i++) expect(b.take('1.2.3.4')).toMatchObject({ ok: true, limit: 5, remaining: 4 - i });
    const refused = b.take('1.2.3.4');
    expect(refused).toMatchObject({ ok: false, remaining: 0, retryAfterSecs: 120, resetSecs: 600 });
  });

  it('refills evenly over the window', () => {
    const c = clock();
    const b = new TokenBucket({ limit: 5, windowMs: 600_000 }, { now: c.now });
    for (let i = 0; i < 5; i++) b.take('k');
    c.advance(119_000);
    expect(b.take('k')).toMatchObject({ ok: false, retryAfterSecs: 1 });
    c.advance(1_000);
    expect(b.take('k').ok).toBe(true);
    expect(b.take('k').ok).toBe(false);
    c.advance(600_000);
    expect(b.peek('k')).toMatchObject({ ok: true, remaining: 4 });
  });

  it('keeps keys independent', () => {
    const b = new TokenBucket({ limit: 1, windowMs: 60_000 }, { now: clock().now });
    expect(b.take('a').ok).toBe(true);
    expect(b.take('a').ok).toBe(false);
    expect(b.take('b').ok).toBe(true);
  });

  it('counts nothing on peek or on a refusal, and gives back a refund', () => {
    const b = new TokenBucket({ limit: 2, windowMs: 60_000 }, { now: clock().now });
    expect(b.peek('a').remaining).toBe(1);
    b.take('a');
    b.take('a');
    b.take('a');
    b.refund('a');
    expect(b.take('a').ok).toBe(true);
    expect(b.take('a').ok).toBe(false);
  });

  it('sweeps refilled buckets and drops the least recently used key past maxKeys', () => {
    const c = clock();
    const b = new TokenBucket({ limit: 2, windowMs: 60_000 }, { now: c.now, maxKeys: 3 });
    for (const k of ['a', 'b', 'c']) b.take(k);
    b.take('a');
    b.take('d');
    expect(b.size).toBe(3);
    // b was the least recently used: it is forgotten (a fresh bucket), a is still spent.
    expect(b.peek('b').remaining).toBe(1);
    expect(b.peek('a').ok).toBe(false);
    c.advance(60_000);
    b.sweep();
    expect(b.size).toBe(0);
  });

  it('sweeps on its own as time passes, so memory stays bounded', () => {
    const c = clock();
    const b = new TokenBucket({ limit: 1, windowMs: 1000 }, { now: c.now });
    for (let i = 0; i < 100; i++) b.take(`k${i}`);
    expect(b.size).toBe(100);
    c.advance(1000);
    b.take('new');
    expect(b.size).toBe(1);
  });

  it('is off with a limit of 0', () => {
    const b = new TokenBucket({ limit: 0, windowMs: 1000 });
    for (let i = 0; i < 50; i++) expect(b.take('a').ok).toBe(true);
    expect(rateLimitHeaders(b.take('a'))).toEqual({});
    expect(b.size).toBe(0);
  });
});

describe('DailyBudget', () => {
  it('counts per key until midnight UTC and then starts again', () => {
    const c = clock(Date.parse('2026-11-14T23:00:00Z'));
    const d = new DailyBudget(2, { now: c.now });
    expect(d.take('check').ok).toBe(true);
    expect(d.take('check')).toMatchObject({ ok: true, remaining: 0 });
    expect(d.take('check')).toMatchObject({ ok: false, retryAfterSecs: 3600, resetSecs: 3600 });
    expect(d.take('chat').ok).toBe(true);
    c.advance(3600_000);
    expect(d.take('check')).toMatchObject({ ok: true, remaining: 1 });
    expect(d.size).toBe(1);
  });

  it('gives back a refund', () => {
    const d = new DailyBudget(1, { now: clock().now });
    d.take('x');
    d.refund('x');
    expect(d.take('x').ok).toBe(true);
  });
});

describe('takeAll', () => {
  it('takes from every limit or from none, and reports the refusal with the longest wait', () => {
    const c = clock(Date.parse('2026-11-14T22:00:00Z'));
    const ip = new TokenBucket({ limit: 5, windowMs: 600_000 }, { now: c.now });
    const daily = new DailyBudget(1, { now: c.now });
    const first = takeAll([
      { limiter: ip, key: '1.2.3.4' },
      { limiter: daily, key: 'check', scope: 'in total' },
    ]);
    expect(first).toMatchObject({ ok: true, remaining: 0, limit: 1 });
    const second = takeAll([
      { limiter: ip, key: '1.2.3.4' },
      { limiter: daily, key: 'check', scope: 'in total' },
    ]);
    expect(second.ok).toBe(false);
    expect(second.refused?.scope).toBe('in total');
    expect(second.retryAfterSecs).toBe(7200);
    // The refused request did not spend the address's tokens.
    expect(ip.peek('1.2.3.4').remaining).toBe(3);
    expect(refusalMessage('private checks', second)).toBe('Too Many Requests: private checks are limited to 1 per day in total; try again in 2 hours.');
  });
});

describe('the 429 answer', () => {
  it('carries Retry-After in seconds, the RateLimit headers and a JSON error', async () => {
    const b = new TokenBucket({ limit: 1, windowMs: 3_600_000 }, { now: clock().now });
    b.take('a');
    const d = takeAll([{ limiter: b, key: 'a', scope: 'from one address' }]);
    const res = tooManyRequests(d, 'chats');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(res.headers.get('ratelimit-limit')).toBe('1');
    expect(res.headers.get('ratelimit-remaining')).toBe('0');
    expect(res.headers.get('ratelimit-reset')).toBe('3600');
    expect(await res.json()).toEqual({ error: 'Too Many Requests: chats are limited to 1 per hour from one address; try again in 60 minutes.', retry_after: 3600 });
  });
});

describe('settings', () => {
  it('reads rates as count per window', () => {
    expect(parseRate('5/10m', '1/1h')).toEqual({ limit: 5, windowMs: 600_000 });
    expect(parseRate('200/d', '1/1h')).toEqual({ limit: 200, windowMs: 86_400_000 });
    expect(parseRate('30 / 1 s', '1/1h')).toEqual({ limit: 30, windowMs: 1000 });
    expect(parseRate('7', '1/1h')).toEqual({ limit: 7, windowMs: 3_600_000 });
    expect(parseRate('', '3/1h')).toEqual({ limit: 3, windowMs: 3_600_000 });
    expect(parseRate(undefined, { limit: 2, windowMs: 5 })).toEqual({ limit: 2, windowMs: 5 });
    expect(parseRate('0', '3/1h').limit).toBe(0);
    expect(parseRate('off', '3/1h').limit).toBe(0);
    expect(() => parseRate('five', '3/1h')).toThrow('a rate is a count per window');
    expect(() => parseRate('5/0m', '3/1h')).toThrow('longer than zero');
    expect(describeRate({ limit: 5, windowMs: 600_000 })).toBe('5 per 10 minutes');
    expect(describeRate({ limit: 3, windowMs: 3_600_000 })).toBe('3 per hour');
  });

  it('reads TRUST_PROXY', () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting('', true)).toBe(true);
    expect(trustProxySetting('1')).toBe(true);
    expect(trustProxySetting('false', true)).toBe(false);
    expect(() => trustProxySetting('maybe')).toThrow('TRUST_PROXY');
  });
});

describe('client addresses', () => {
  it('keys IPv4 as is, IPv4-mapped IPv6 as IPv4 and IPv6 by its /64', () => {
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('203.0.113.9:5123')).toBe('203.0.113.9');
    expect(addressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(addressKey('[2001:db8::1]:443')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
  });

  it('reads X-Forwarded-For only behind a trusted proxy, and only its first hop', () => {
    expect(clientAddress({ forwardedFor: '198.51.100.7, 10.0.0.2', remote: '172.18.0.5', trustProxy: true })).toBe('198.51.100.7');
    expect(clientAddress({ forwardedFor: '198.51.100.7', remote: '172.18.0.5', trustProxy: false })).toBe('172.18.0.5');
    expect(clientAddress({ forwardedFor: 'not an address', remote: '172.18.0.5', trustProxy: true })).toBe('172.18.0.5');
    expect(clientAddress({ forwardedFor: null, remote: null, trustProxy: true })).toBe('unknown');
  });
});

describe('rateLimit middleware', () => {
  const ctx = (headers: Record<string, string>, remote?: string): RateLimitContext & { res: Response } => ({
    req: { header: (name: string) => headers[name.toLowerCase()] },
    env: remote ? { incoming: { socket: { remoteAddress: remote } } } : undefined,
    res: new Response('ok'),
  });

  it('passes with RateLimit headers on the response, then answers 429 by client address', async () => {
    const mw = rateLimit({ what: 'chats', trustProxy: false, rules: [{ limiter: new TokenBucket({ limit: 1, windowMs: 60_000 }) }] });
    const c = ctx({}, '::ffff:192.0.2.1');
    let ran = 0;
    expect(await mw(c, async () => void ran++)).toBeUndefined();
    expect(ran).toBe(1);
    expect(c.res.headers.get('ratelimit-remaining')).toBe('0');
    const refused = await mw(ctx({}, '192.0.2.1'), async () => void ran++);
    expect(refused?.status).toBe(429);
    expect(ran).toBe(1);
    expect((await refused!.json()).error).toMatch(/^Too Many Requests: chats are limited to 1 per minute from one address/);
    expect(await mw(ctx({}, '192.0.2.2'), async () => void ran++)).toBeUndefined();
  });

  it('counts per forwarded client behind a trusted proxy, and skips a rule whose key is undefined', async () => {
    const perIp = new TokenBucket({ limit: 1, windowMs: 60_000 });
    const paid = new TokenBucket({ limit: 1, windowMs: 60_000 });
    const mw = rateLimit({
      what: 'requests',
      trustProxy: true,
      rules: [{ limiter: perIp }, { limiter: paid, key: (c, a) => (c.req.header('x-payment') ? a : undefined) }],
    });
    const next = async () => {};
    expect(await mw(ctx({ 'x-forwarded-for': '198.51.100.1' }, '172.18.0.9'), next)).toBeUndefined();
    expect(await mw(ctx({ 'x-forwarded-for': '198.51.100.2' }, '172.18.0.9'), next)).toBeUndefined();
    expect((await mw(ctx({ 'x-forwarded-for': '198.51.100.1' }, '172.18.0.9'), next))?.status).toBe(429);
    expect(perIp.size).toBe(2);
    expect(paid.size).toBe(0);
  });
});

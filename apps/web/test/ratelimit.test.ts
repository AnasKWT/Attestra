// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRateLimited, readableError } from '@/lib/useFetch';

vi.mock('attestra-mcp', () => ({ handleMcpRequest: async () => Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) }));

describe('the hosted /mcp route', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('limits requests per client address and says when to try again', async () => {
    vi.stubEnv('MCP_RATE_IP', '2/1m');
    vi.stubEnv('VERCEL', '1');
    const { POST } = await import('@/app/mcp/route');
    const from = (ip: string) => POST(new Request('http://site.test/mcp', { method: 'POST', body: '{}', headers: { 'x-forwarded-for': ip } }));
    const first = await from('198.51.100.1');
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-remaining')).toBe('1');
    expect(first.headers.get('access-control-expose-headers')).toMatch(/Retry-After/);
    expect((await from('198.51.100.1')).status).toBe(200);
    const refused = await from('198.51.100.1');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('30');
    expect(refused.headers.get('access-control-allow-origin')).toBe('*');
    expect(((await refused.json()) as { error: string }).error).toBe('Too Many Requests: MCP requests are limited to 2 per minute from one address; try again in 30 seconds.');
    expect((await from('198.51.100.2')).status).toBe(200);
  });
});

describe('rate limit messages', () => {
  it('keeps the service sentence and words any other 429 plainly', () => {
    const server = 'Too Many Requests: private checks are limited to 5 per 10 minutes from one address; try again in 7 minutes.';
    expect(readableError(server)).toBe(server);
    expect(readableError(`membership request: ${server}`)).toBe(server);
    expect(readableError('the agent answered 429')).toMatch(/^Too Many Requests: the service is limiting requests from this browser for now/);
    expect(readableError('RPC https://rpc.testnet.near.org: TOO_MANY_REQUESTS')).toMatch(/^Too Many Requests:/);
    expect(isRateLimited('too many fields')).toBe(false);
    expect(readableError('Failed to fetch')).toBe('Not reachable from this browser.');
  });
});

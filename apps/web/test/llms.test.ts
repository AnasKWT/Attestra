import { describe, expect, it } from 'vitest';
import { GET } from '@/app/llms.txt/route';

describe('llms.txt', () => {
  it('describes the protocol, contracts, tools and API', async () => {
    const text = await GET().text();
    for (const s of ['# Attestra', 'attestations.attestra.testnet', 'get_attestation', '/api/attestations', 'npx -y @attestra/mcp']) expect(text).toContain(s);
  });
});

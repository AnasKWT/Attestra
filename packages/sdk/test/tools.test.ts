import { describe, expect, it } from 'vitest';
import { AttestraClient } from '../src/client';
import { READ_TOOLS, TOOLS, WRITE_TOOLS, openAITools, runTool } from '../src/tools';
import { knownSchemas } from '../src/schemas';

describe('agent tools', () => {
  const client = new AttestraClient({ network: 'testnet' });

  it('exposes read and write tools with JSON schemas', () => {
    expect(READ_TOOLS).toContain('get_attestation');
    expect(READ_TOOLS).toContain('prove_attestation');
    expect(WRITE_TOOLS).toEqual(expect.arrayContaining(['register_schema', 'create_attestation', 'revoke_attestation', 'request_private_check']));
    for (const t of TOOLS) expect(t.parameters.type).toBe('object');
    expect(openAITools().length).toBe(READ_TOOLS.length);
    expect(openAITools({ includeWrites: true }).length).toBe(TOOLS.length);
  });

  it('blocks writes unless allowed, and runs pure tools offline', async () => {
    const blocked = (await runTool(client, 'register_schema', { definition: 'string a', revocable: true })) as { ok: boolean };
    expect(blocked.ok).toBe(false);
    const uid = (await runTool(client, 'compute_schema_uid', { definition: 'string name, u8 level', revocable: true })) as { data: { uid: string } };
    expect(uid.data.uid).toBe('b7707f26a2b3f1bd97ad1c8919f9c78e47031eb71092bdc441ed441110b8f452');
    const dec = (await runTool(client, 'decode_data', { definition: 'string name, u8 level', data: 'AgAAAEJvBw==' })) as { data: unknown };
    expect(dec.data).toEqual({ name: 'Bo', level: 7 });
    const unknown = (await runTool(client, 'nope', {})) as { ok: boolean };
    expect(unknown.ok).toBe(false);
  });

  it('well-known schemas have stable UIDs', () => {
    const all = knownSchemas();
    expect(new Set(all.map((s) => s.uid)).size).toBe(all.length);
    for (const s of all) expect(s.uid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('client config switches networks', () => {
    expect(client.contracts.attestations).toBe('attestations.attestra.testnet');
    const main = new AttestraClient({ network: 'mainnet' });
    expect(main.contracts.attestations).toBe('attestations.attestra.near');
    expect(main.config.mpc).toBe('v1.signer');
    const custom = new AttestraClient({ network: 'testnet', root: 'demo.testnet' });
    expect(custom.contracts.resolvers.fee).toBe('fee.demo.testnet');
  });

  it('writes without a signer fail as configuration errors', async () => {
    const r = await client.registerSchema({ definition: 'string a', revocable: true });
    expect(r.success).toBe(false);
    expect(r.error?.type).toBe('CONFIGURATION_ERROR');
  });
});

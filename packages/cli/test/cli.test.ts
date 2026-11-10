import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = (...args: string[]) => execFileSync('node', [cli, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
/** No signer from the caller's shell, so signing commands fail the same way everywhere. */
const unsigned = () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.ATTESTRA_ACCOUNT_ID;
  delete env.ATTESTRA_PRIVATE_KEY;
  return env;
};
/** Runs a command expected to fail and returns its JSON error. */
const failing = (...args: string[]) => {
  try {
    execFileSync('node', [cli, ...args], { encoding: 'utf8', env: unsigned(), stdio: 'pipe' });
  } catch (e) {
    return JSON.parse((e as { stderr: string }).stderr) as { success: boolean; error: { type: string; message: string } };
  }
  throw new Error(`${args.join(' ')} did not fail`);
};
const KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';

describe('attestra binary (offline commands)', () => {
  beforeAll(() => {
    execFileSync('npx', ['tsup'], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' });
  });

  it('lists every command group', () => {
    const help = run('--help');
    for (const g of ['schema', 'blob', 'attestation', 'authority', 'storage', 'delegate', 'whitelist', 'fee', 'token-gated', 'token-reward', 'pipeline', 'credential', 'schedule', 'multisig', 'staking', 'token', 'events', 'check', 'chain', 'agent', 'pay', 'ai']) {
      expect(help).toContain(g);
    }
  });

  it('computes schema UIDs and encodes data as JSON', () => {
    const uid = JSON.parse(run('--json', 'schema', 'uid', '-d', 'string name, u8 level', '--revocable'));
    expect(uid).toEqual({ success: true, data: { uid: 'b7707f26a2b3f1bd97ad1c8919f9c78e47031eb71092bdc441ed441110b8f452' } });
    const enc = JSON.parse(run('--json', 'encode', 'string name, u8 level', '{"name":"Bo","level":7}'));
    expect(enc.data.data).toBe('AgAAAEJvBw==');
    const dec = JSON.parse(run('--json', 'decode', 'string name, u8 level', 'AgAAAEJvBw=='));
    expect(dec.data).toEqual({ name: 'Bo', level: 7 });
  });

  it('reports configuration and validation errors as JSON with a non-zero exit', () => {
    let failed = false;
    try {
      run('--json', 'schema', 'create', '-d', 'string a', '--revocable');
    } catch (e) {
      failed = true;
      const out = JSON.parse((e as { stderr: string }).stderr);
      expect(out.success).toBe(false);
      expect(out.error.type).toBe('CONFIGURATION_ERROR');
    }
    expect(failed).toBe(true);
  });

  it('checks agent key grants before asking for a signer', () => {
    const refused = failing('--json', 'agent', 'grant-key', KEY, '--methods', 'attest,storage_withdraw');
    expect(refused.error.type).toBe('VALIDATION_ERROR');
    expect(refused.error.message).toMatch(/does not allow storage_withdraw/);
    expect(failing('--json', 'agent', 'grant-key', KEY, '--allowance', 'lots').error.type).toBe('VALIDATION_ERROR');
    expect(failing('--json', 'agent', 'grant-key', KEY).error.type).toBe('CONFIGURATION_ERROR');
    expect(failing('--json', 'agent', 'revoke-key', KEY).error.type).toBe('CONFIGURATION_ERROR');
  });

  it('lists agent keys from the RPC as JSON', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const rpc = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const r = JSON.parse(body);
        requests.push(r);
        const fc = (receiver: string) => ({ FunctionCall: { allowance: '250000000000000000000000', receiver_id: receiver, method_names: ['attest', 'revoke'] } });
        const keys = [
          { public_key: KEY, access_key: { nonce: 1, permission: fc('attestations.attestra.testnet') } },
          { public_key: 'ed25519:other', access_key: { nonce: 1, permission: fc('app.testnet') } },
          { public_key: 'ed25519:full', access_key: { nonce: 1, permission: 'FullAccess' } },
        ];
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { keys, block_height: 1 } }));
      });
    });
    await new Promise<void>((ok) => rpc.listen(0, '127.0.0.1', ok));
    try {
      const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
      const { stdout } = await promisify(execFile)('node', [cli, '--json', '--rpc', url, 'agent', 'keys', 'owner.testnet'], { encoding: 'utf8', env: unsigned() });
      expect(JSON.parse(stdout)).toEqual({
        success: true,
        data: { keys: [{ publicKey: KEY, receiverId: 'attestations.attestra.testnet', methodNames: ['attest', 'revoke'], allowance: '250000000000000000000000' }] },
      });
      expect(requests[0]).toMatchObject({ method: 'query', params: { request_type: 'view_access_key_list', account_id: 'owner.testnet' } });
    } finally {
      rpc.close();
    }
  });
});

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const run = (...args: string[]) => execFileSync('node', [cli, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

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
});

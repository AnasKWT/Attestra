import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keychainKey, resolveConfig } from '../src/config';

describe('CLI config', () => {
  it('flags beat env, env beats defaults', () => {
    const env = { ATTESTRA_NETWORK: 'mainnet', ATTESTRA_ACCOUNT_ID: 'env.near', ATTESTRA_INDEXER_URL: 'http://idx' };
    expect(resolveConfig({}, env).network).toBe('mainnet');
    expect(resolveConfig({ network: 'testnet' }, env).network).toBe('testnet');
    expect(resolveConfig({ account: 'flag.near' }, env).accountId).toBe('flag.near');
    expect(resolveConfig({}, env).indexerUrl).toBe('http://idx');
    expect(resolveConfig({}, {}).indexerUrl).toBe('https://api.attestra.site/indexer');
    expect(resolveConfig({ network: 'mainnet' }, {}).indexerUrl).toBe('http://localhost:5100');
    expect(() => resolveConfig({ network: 'devnet' }, {})).toThrow(/testnet or mainnet/);
  });

  it('reads keys from the NEAR CLI keychain', () => {
    const home = mkdtempSync(join(tmpdir(), 'attestra-cli-'));
    mkdirSync(join(home, '.near-credentials', 'testnet'), { recursive: true });
    writeFileSync(join(home, '.near-credentials', 'testnet', 'alice.testnet.json'), JSON.stringify({ account_id: 'alice.testnet', private_key: 'ed25519:abc' }));
    expect(keychainKey('testnet', 'alice.testnet', home)).toBe('ed25519:abc');
    expect(keychainKey('testnet', 'bob.testnet', home)).toBeUndefined();
    expect(resolveConfig({ account: 'alice.testnet' }, {}, home).privateKey).toBe('ed25519:abc');
    expect(resolveConfig({ account: 'alice.testnet' }, { ATTESTRA_PRIVATE_KEY: 'ed25519:env' }, home).privateKey).toBe('ed25519:env');
  });
});

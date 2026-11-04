import { describe, expect, it } from 'vitest';
import { checkPayment, decodeHeader, encodeHeader, selectRequirements, type PaymentRequirements } from '../src/x402';

const req: PaymentRequirements = {
  scheme: 'exact',
  network: 'near:testnet',
  amount: '1000000000000000000',
  asset: 'token.attestra.testnet',
  payTo: 'agent.attestra.testnet',
  maxTimeoutSeconds: 60,
};

describe('x402 on NEAR', () => {
  it('round-trips headers', () => {
    const v = { a: 1, s: 'é' };
    expect(decodeHeader(encodeHeader(v))).toEqual(v);
  });

  it('selects an acceptable requirement', () => {
    const r = selectRequirements({ x402Version: 2, resource: { url: 'x' }, accepts: [req] }, 'testnet', 10n ** 19n);
    expect(r.payTo).toBe('agent.attestra.testnet');
    expect(() => selectRequirements({ x402Version: 2, resource: { url: 'x' }, accepts: [req] }, 'testnet', 1n)).toThrow();
    expect(() => selectRequirements({ x402Version: 2, resource: { url: 'x' }, accepts: [req] }, 'mainnet', 10n ** 30n)).toThrow();
  });

  it('refuses malformed payments', () => {
    const bad = { x402Version: 2, scheme: 'exact' as const, network: 'near:testnet', accepted: req, payload: { signedDelegateAction: 'AAAA' } };
    expect(checkPayment(bad, req).ok).toBe(false);
    expect(checkPayment({ ...bad, x402Version: 1 }, req).reason).toMatch(/version/);
    expect(checkPayment({ ...bad, network: 'near:mainnet' }, req).reason).toMatch(/network/);
  });
});

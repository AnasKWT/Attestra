import { describe, expect, it } from 'vitest';
import { formatAmount, formatCount, parseAmount, shortAccount, timeAgo, truncate } from '@/lib/format';

describe('format helpers', () => {
  it('truncates hashes and implicit accounts but keeps readable names', () => {
    expect(truncate('a'.repeat(64), 6, 4)).toBe('aaaaaa...aaaa');
    expect(truncate('short')).toBe('short');
    expect(shortAccount('alice.testnet')).toBe('alice.testnet');
    expect(shortAccount('ab'.repeat(32))).toBe('ababab...ababab');
  });

  it('converts amounts both ways', () => {
    expect(formatAmount('1500000000000000000000000')).toBe('1.5');
    expect(formatAmount('1000000000000000000', 18)).toBe('1');
    expect(parseAmount('1.5')).toBe('1500000000000000000000000');
    expect(parseAmount('100', 18)).toBe('100000000000000000000');
    expect(parseAmount('0.000001', 6)).toBe('1');
    expect(() => parseAmount('abc')).toThrow();
  });

  it('formats counts and relative times', () => {
    expect(formatCount(12_500)).toBe('12.5k');
    expect(formatCount(42)).toBe('42');
    expect(timeAgo(100, 160)).toBe('1m ago');
    expect(timeAgo(200, 100)).toBe('in 2m');
  });
});

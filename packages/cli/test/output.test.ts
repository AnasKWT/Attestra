import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatError, formatOutput } from '../src/output';

describe('CLI output', () => {
  it('JSON success and error shapes are stable', () => {
    expect(JSON.parse(formatOutput({ uid: 'ab' }, true, 'TX'))).toEqual({ success: true, data: { uid: 'ab' }, tx_hash: 'TX' });
    expect(JSON.parse(formatOutput({ uid: 'ab' }, true))).toEqual({ success: true, data: { uid: 'ab' } });
    expect(JSON.parse(formatError('NOT_FOUND', 'missing', true))).toEqual({ success: false, error: { type: 'NOT_FOUND', message: 'missing' } });
    expect(formatError('NOT_FOUND', 'missing')).toContain('NOT_FOUND');
  });

  it('JSON output always parses (property)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))), (data) => {
        const parsed = JSON.parse(formatOutput(data, true));
        expect(parsed.success).toBe(true);
        expect(parsed.data).toEqual(data);
      }),
    );
  });

  it('human output names every key', () => {
    const text = formatOutput({ schemaUid: 'x', nested: { a: 1 } });
    expect(text).toContain('schemaUid');
    expect(text).toContain('a');
  });
});

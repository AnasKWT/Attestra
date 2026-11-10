import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARK, MARK_COLORS } from '../src/components/brand/mark';

describe('the mark', () => {
  it('icon.svg draws the same paths, widths and colours as the components', () => {
    const svg = readFileSync(join(__dirname, '../src/app/icon.svg'), 'utf8');
    expect(svg).toContain(`viewBox="${MARK.viewBox}"`);
    expect(svg).toContain(`stroke-width="${MARK.hexWidth}" d="${MARK.hex}"`);
    expect(svg).toContain(`stroke-width="${MARK.checkWidth}" d="${MARK.check}"`);
    for (const c of Object.values(MARK_COLORS)) expect(svg).toContain(c);
  });
});

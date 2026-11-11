import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARK, MARK_COLORS } from '../src/components/brand/mark';

describe('the mark', () => {
  it('icon.svg draws the same hexagon, strokes, widths, cut and colours as the components', () => {
    const svg = readFileSync(join(__dirname, '../src/app/icon.svg'), 'utf8');
    expect(svg).toContain(`viewBox="${MARK.viewBox}"`);
    expect(svg).toContain(`d="${MARK.short}"`);
    expect(svg.match(new RegExp(`d="${MARK.long}"`, 'g'))).toHaveLength(2);
    expect(svg).toContain(`d="${MARK.hex}"`);
    expect(svg).toContain(`stroke-width="${MARK.hexWidth}"`);
    expect(svg).toContain(`stroke-width="${MARK.width}"`);
    expect(svg).toContain(`stroke-width="${MARK.width + 2 * MARK.gap}"`);
    for (const c of Object.values(MARK_COLORS)) expect(svg).toContain(c);
  });
});

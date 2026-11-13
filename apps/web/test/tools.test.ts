import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GROUPS, TOOLS, toolBySlug } from '@/lib/tools';

describe('sandbox tool registry', () => {
  it('has a page for every tool and no duplicates', () => {
    expect(new Set(TOOLS.map((t) => t.slug)).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      expect(GROUPS).toContain(t.group);
      expect(existsSync(join(__dirname, '../src/app/sandbox/app', t.slug, 'page.tsx'))).toBe(true);
    }
  });

  it('keeps the 25 core tools plus the NEAR groups', () => {
    const core = TOOLS.filter((t) => !['Only on NEAR', 'Agent'].includes(t.group));
    expect(core.length).toBe(25);
    expect(TOOLS.filter((t) => t.group === 'Only on NEAR').length).toBe(6);
    expect(toolBySlug('agent-chat')?.group).toBe('Agent');
    expect(toolBySlug('nope')).toBeUndefined();
  });
});

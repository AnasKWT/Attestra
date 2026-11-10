import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Logo } from '@/components/brand/Logo';
import { highlight } from '@/components/ui/Code';
import { Badge, StatusBadge } from '@/components/ui/primitives';

describe('UI components', () => {
  it('renders the wordmark', () => {
    render(<Logo />);
    expect(screen.getByText(/Attest/)).toBeInTheDocument();
  });

  it('maps statuses to badges', () => {
    render(
      <div>
        <StatusBadge status="active" />
        <StatusBadge status="revoked" />
        <Badge tone="brand">brand</Badge>
      </div>,
    );
    expect(screen.getByText('active').className).toMatch(/emerald/);
    expect(screen.getByText('revoked').className).toMatch(/red/);
  });

  it('highlights code tokens without losing text', () => {
    const code = "const x = await f('a', 42); // done";
    const { container } = render(<pre>{highlight(code)}</pre>);
    expect(container.textContent).toBe(code);
    expect(container.querySelector('.tok-k')?.textContent).toBe('const');
    expect(container.querySelector('.tok-s')?.textContent).toBe("'a'");
    expect(container.querySelector('.tok-n')?.textContent).toBe('42');
    expect(container.querySelector('.tok-c')?.textContent).toBe('// done');
  });
});

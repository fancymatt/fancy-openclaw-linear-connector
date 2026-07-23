import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { Link } from './Link';

describe('Link', () => {
  it('renders an anchor with href', () => {
    render(<Link href="/about">About</Link>);
    const link = screen.getByRole('link', { name: /about/i });
    expect(link).toHaveAttribute('href', '/about');
  });

  it('renders children', () => {
    render(<Link href="/docs">Documentation</Link>);
    expect(screen.getByText('Documentation')).toBeInTheDocument();
  });

  it('external variant adds target and rel', () => {
    render(
      <Link href="https://example.com" variant="external">
        External
      </Link>,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('external variant renders an icon', () => {
    const { container } = render(
      <Link href="https://example.com" variant="external">
        Away
      </Link>,
    );
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('default variant does not add target=_blank', () => {
    render(<Link href="/internal">Internal</Link>);
    expect(screen.getByRole('link')).not.toHaveAttribute('target');
  });

  it('muted variant applies muted class', () => {
    const { container } = render(
      <Link href="/quiet" variant="muted">
        Quiet
      </Link>,
    );
    const link = container.querySelector('a')!;
    expect(link.className).toMatch(/muted/);
  });

  it('forwards ref to the anchor element', () => {
    const ref = createRef<HTMLAnchorElement>();
    render(<Link href="/test" ref={ref}>Test</Link>);
    expect(ref.current).toBeInstanceOf(HTMLAnchorElement);
  });
});

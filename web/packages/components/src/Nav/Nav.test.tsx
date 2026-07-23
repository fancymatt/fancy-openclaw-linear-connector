import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Nav, type NavItem } from './Nav';

const sampleItems: NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact', active: true },
];

describe('Nav', () => {
  it('renders all nav items', () => {
    render(<Nav items={sampleItems} />);
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('About')).toBeInTheDocument();
    expect(screen.getByText('Contact')).toBeInTheDocument();
  });

  it('renders items as links with correct hrefs', () => {
    render(<Nav items={sampleItems} />);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about');
  });

  it('marks the active item', () => {
    const { container } = render(<Nav items={sampleItems} />);
    const activeLink = container.querySelector('a[href="/contact"]')!;
    expect(activeLink.className).toMatch(/active/);
  });

  it('does not mark inactive items as active', () => {
    const { container } = render(<Nav items={sampleItems} />);
    const inactiveLink = container.querySelector('a[href="/"]')!;
    expect(inactiveLink.className).not.toMatch(/active/);
  });

  it('renders logo when provided', () => {
    render(<Nav items={sampleItems} logo={{ label: 'MyApp', href: '/' }} />);
    const logoLink = screen.getByText('MyApp');
    expect(logoLink).toBeInTheDocument();
    expect(logoLink).toHaveAttribute('href', '/');
  });

  it('does not render logo when omitted', () => {
    render(<Nav items={sampleItems} />);
    expect(screen.queryByText('MyApp')).not.toBeInTheDocument();
  });

  it('renders actions when provided', () => {
    render(
      <Nav items={sampleItems} actions={<button data-testid="action-btn">Login</button>} />,
    );
    expect(screen.getByTestId('action-btn')).toBeInTheDocument();
  });

  it('renders a nav landmark element', () => {
    render(<Nav items={sampleItems} />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });
});

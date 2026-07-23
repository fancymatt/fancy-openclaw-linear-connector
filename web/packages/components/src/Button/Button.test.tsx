import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: /click me/i })).toBeInTheDocument();
  });

  it('applies the primary variant class by default', () => {
    const { container } = render(<Button>Test</Button>);
    const btn = container.querySelector('button')!;
    expect(btn.className).toMatch(/primary/);
  });

  it('renders all four variants', () => {
    const variants = ['primary', 'secondary', 'ghost', 'danger'] as const;
    for (const variant of variants) {
      const { container } = render(<Button variant={variant}>{variant}</Button>);
      const btn = container.querySelector('button')!;
      expect(btn.className).toContain(variant);
    }
  });

  it('renders all three sizes', () => {
    const sizes = ['sm', 'md', 'lg'] as const;
    for (const size of sizes) {
      const { container } = render(<Button size={size}>{size}</Button>);
      const btn = container.querySelector('button')!;
      expect(btn.className).toContain(size);
    }
  });

  it('shows a loading spinner when loading', () => {
    const { container } = render(<Button loading>Save</Button>);
    const spinner = container.querySelector('[aria-hidden="true"]');
    expect(spinner).toBeTruthy();
  });

  it('disables interaction when loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is disabled when disabled prop is set', () => {
    render(<Button disabled>Nope</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('fires onClick when clicked', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

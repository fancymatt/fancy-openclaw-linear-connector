import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { Input } from './Input';

describe('Input', () => {
  it('renders a label when provided', () => {
    render(<Input label="Email" />);
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('renders an input element', () => {
    render(<Input label="Email" placeholder="you@example.com" />);
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
  });

  it('shows error message when error is set', () => {
    render(<Input label="Email" error="Invalid email" />);
    expect(screen.getByText('Invalid email')).toBeInTheDocument();
  });

  it('shows helper text when provided and no error', () => {
    render(<Input label="Email" helperText="We'll never share your email" />);
    expect(screen.getByText("We'll never share your email")).toBeInTheDocument();
  });

  it('does not show helper text when error is present', () => {
    render(<Input label="Email" error="Error!" helperText="Helper" />);
    expect(screen.queryByText('Helper')).not.toBeInTheDocument();
    expect(screen.getByText('Error!')).toBeInTheDocument();
  });

  it('renders an icon when provided', () => {
    const { container } = render(
      <Input label="Search" icon={<svg data-testid="icon" />} />,
    );
    expect(container.querySelector('[data-testid="icon"]')).toBeTruthy();
  });

  it('forwards ref to the input element', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input label="Test" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('passes through standard input props', () => {
    render(<Input label="Test" placeholder="hello" type="email" disabled />);
    const input = screen.getByPlaceholderText('hello');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('type', 'email');
  });
});

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Heading } from './Heading';
import { Text } from './Text';

describe('Heading', () => {
  it('renders an h2 by default', () => {
    const { container } = render(<Heading>Title</Heading>);
    expect(container.querySelector('h2')).toBeTruthy();
  });

  it('renders an h1 when as="h1"', () => {
    const { container } = render(<Heading as="h1">Big Title</Heading>);
    expect(container.querySelector('h1')).toBeTruthy();
  });

  it('renders h3-h6 correctly', () => {
    const levels = ['h3', 'h4', 'h5', 'h6'] as const;
    for (const level of levels) {
      const { container } = render(<Heading as={level}>{level}</Heading>);
      expect(container.querySelector(level)).toBeTruthy();
    }
  });

  it('applies the heading base class', () => {
    const { container } = render(<Heading>Test</Heading>);
    const h2 = container.querySelector('h2')!;
    expect(h2.className).toMatch(/heading/);
  });

  it('applies the correct level class', () => {
    const { container } = render(<Heading as="h1">Test</Heading>);
    const h1 = container.querySelector('h1')!;
    expect(h1.className).toMatch(/h1/);
  });

  it('passes through extra props', () => {
    render(
      <Heading as="h3" id="my-heading" data-testid="heading">
        Content
      </Heading>,
    );
    const el = screen.getByTestId('heading');
    expect(el).toHaveAttribute('id', 'my-heading');
  });
});

describe('Text', () => {
  it('renders a p element', () => {
    const { container } = render(<Text>Hello world</Text>);
    expect(container.querySelector('p')).toBeTruthy();
  });

  it('renders children', () => {
    render(<Text>Hello world</Text>);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('applies the body variant class by default', () => {
    const { container } = render(<Text>Body text</Text>);
    const p = container.querySelector('p')!;
    expect(p.className).toMatch(/body/);
  });

  it('applies the small variant class', () => {
    const { container } = render(<Text variant="small">Small text</Text>);
    const p = container.querySelector('p')!;
    expect(p.className).toMatch(/small/);
  });

  it('applies the caption variant class', () => {
    const { container } = render(<Text variant="caption">Caption text</Text>);
    const p = container.querySelector('p')!;
    expect(p.className).toMatch(/caption/);
  });

  it('passes through extra props', () => {
    render(
      <Text id="description" data-testid="text">
        Content
      </Text>,
    );
    const el = screen.getByTestId('text');
    expect(el).toHaveAttribute('id', 'description');
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from '../components/button';

describe('Button', () => {
  it('renders an accessible button with its label', () => {
    render(<Button>Open Space</Button>);

    expect(screen.getByRole('button', { name: 'Open Space' })).toBeInTheDocument();
  });

  it('applies the default variant classes', () => {
    render(<Button>Default</Button>);

    expect(screen.getByRole('button')).toHaveClass('bg-foreground');
  });

  it('lets a caller override a conflicting utility', () => {
    render(<Button className="px-10">Wide</Button>);

    const button = screen.getByRole('button');
    expect(button).toHaveClass('px-10');
    expect(button).not.toHaveClass('px-4');
  });

  it('renders as the child element when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/somewhere">Go</a>
      </Button>,
    );

    expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute('href', '/somewhere');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is not operable when disabled', () => {
    render(<Button disabled>Disabled</Button>);

    expect(screen.getByRole('button')).toBeDisabled();
  });
});

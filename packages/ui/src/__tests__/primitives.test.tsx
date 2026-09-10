import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Badge, StatusDot } from '../components/badge';
import { Switch } from '../components/switch';

describe('Badge', () => {
  it('renders the badge text', () => {
    render(<Badge>Planned</Badge>);

    expect(screen.getByText('Planned')).toBeInTheDocument();
  });

  it('applies the variant classes', () => {
    render(<Badge variant="success">Done</Badge>);

    expect(screen.getByText('Done')).toHaveClass('ring-success/30');
  });
});

describe('StatusDot', () => {
  it('labels a purely-colour status for assistive technology', () => {
    render(<StatusDot tone="danger" label="Overdue" />);

    expect(screen.getByText('Overdue')).toHaveClass('sr-only');
  });
});

describe('Switch', () => {
  it('is an accessible switch reflecting its state', () => {
    render(<Switch label="Notifications" defaultChecked />);

    expect(screen.getByRole('switch', { name: 'Notifications' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('toggles its internal state when uncontrolled', () => {
    render(<Switch label="Notifications" />);

    const toggle = screen.getByRole('switch', { name: 'Notifications' });
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('reports checked changes to the parent', () => {
    const onCheckedChange = vi.fn();
    render(<Switch label="Mail" onCheckedChange={onCheckedChange} />);

    fireEvent.click(screen.getByRole('switch', { name: 'Mail' }));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});

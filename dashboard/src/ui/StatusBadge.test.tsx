import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge.js';

describe('StatusBadge', () => {
  it('renders the tenant-status label from the F1 map', () => {
    render(<StatusBadge kind="tenant" status="placed" />);
    expect(screen.getByText('Placed')).toBeInTheDocument();
  });

  it('renders the listing-status label from the F1 map', () => {
    render(<StatusBadge kind="listing" status="under_application" />);
    expect(screen.getByText('Under application')).toBeInTheDocument();
  });

  it('falls back to a humanized form for an off-list value', () => {
    render(<StatusBadge kind="tenant" status="some_legacy_value" />);
    expect(screen.getByText('Some legacy value')).toBeInTheDocument();
  });
});

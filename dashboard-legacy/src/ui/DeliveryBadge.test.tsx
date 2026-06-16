import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeliveryBadge } from './DeliveryBadge.js';

describe('<DeliveryBadge>', () => {
  it('renders the status label for a non-failure state', () => {
    render(<DeliveryBadge status="delivered" />);
    expect(screen.getByText('Delivered')).toBeInTheDocument();
  });

  it('appends the human-readable reason for a failure with an error code', () => {
    render(<DeliveryBadge status="failed" errorCode="30005" />);
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
    expect(screen.getByText(/invalid/i)).toBeInTheDocument();
  });

  it('does not treat "sent" as a failure (no reason shown)', () => {
    render(<DeliveryBadge status="sent" errorCode="30005" />);
    // "sent" is not a failure, so even a stray errorCode must not surface a reason.
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.queryByText(/invalid/i)).not.toBeInTheDocument();
  });
});

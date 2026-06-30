// StatChips + DeliveryBadge + BroadcastStatusPill component tests (§8) — the
// rollup chips render label+count text (a11y: status by text, not colour), the
// delivery badge maps a recipient status to a text label and surfaces the Twilio
// error reason on a failure, and the lifecycle pill renders its label.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BroadcastStats } from '../../api/index.js';
import { StatChips } from './StatChips.js';
import { DeliveryBadge } from './DeliveryBadge.js';
import { BroadcastStatusPill } from './BroadcastStatusPill.js';

function stats(over: Partial<BroadcastStats> = {}): BroadcastStats {
  return { audience: 5, sent: 2, delivered: 1, failed: 0, skipped_opted_out: 0, queued: 2, ...over };
}

describe('StatChips', () => {
  it('renders every rollup chip as a label/value pair', () => {
    render(<StatChips stats={stats({ audience: 5, delivered: 3, sent: 4, queued: 1, failed: 2 })} />);
    const list = screen.getByLabelText('Delivery stats');
    expect(within(list).getByText('Recipients')).toBeInTheDocument();
    // Recipients = audience (5)
    expect(within(within(list).getByText('Recipients').closest('div') as HTMLElement).getByText('5')).toBeInTheDocument();
    expect(within(within(list).getByText('Delivered').closest('div') as HTMLElement).getByText('3')).toBeInTheDocument();
    expect(within(within(list).getByText('Sent').closest('div') as HTMLElement).getByText('4')).toBeInTheDocument();
    expect(within(within(list).getByText('Queued').closest('div') as HTMLElement).getByText('1')).toBeInTheDocument();
    expect(within(within(list).getByText('Failed').closest('div') as HTMLElement).getByText('2')).toBeInTheDocument();
  });
});

describe('DeliveryBadge', () => {
  it('renders the queued/sent/delivered status as text', () => {
    const { rerender } = render(<DeliveryBadge status="queued" />);
    expect(screen.getByText('Sending…')).toBeInTheDocument();
    rerender(<DeliveryBadge status="sent" />);
    expect(screen.getByText('Sent')).toBeInTheDocument();
    rerender(<DeliveryBadge status="delivered" />);
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    rerender(<DeliveryBadge status="skipped" />);
    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });

  it('appends the Twilio error reason on a failure', () => {
    render(<DeliveryBadge status="failed" errorCode="30003" />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/Phone unreachable/i)).toBeInTheDocument();
  });

  it('shows just the Failed label when no error code is supplied', () => {
    render(<DeliveryBadge status="failed" />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });
});

describe('BroadcastStatusPill', () => {
  it('renders the lifecycle label for each status', () => {
    const { rerender } = render(<BroadcastStatusPill status="draft" />);
    expect(screen.getByText('Draft')).toBeInTheDocument();
    rerender(<BroadcastStatusPill status="sending" />);
    expect(screen.getByText('Sending')).toBeInTheDocument();
    rerender(<BroadcastStatusPill status="sent" />);
    expect(screen.getByText('Sent')).toBeInTheDocument();
    rerender(<BroadcastStatusPill status="failed" />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});

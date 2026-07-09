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
  return {
    audience: 5,
    sent: 2,
    delivered: 1,
    failed: 0,
    skipped_opted_out: 0,
    skipped_no_consent: 0,
    queued: 2,
    ...over,
  };
}

/** The count inside a given chip (looked up by its label). */
function chipValue(list: HTMLElement, label: string): string {
  return (within(list).getByText(label).closest('div') as HTMLElement).textContent ?? '';
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

  it('renders a Skipped chip summing opted-out + no-consent', () => {
    render(<StatChips stats={stats({ skipped_opted_out: 2, skipped_no_consent: 3 })} />);
    const list = screen.getByLabelText('Delivery stats');
    // Skipped = 2 opted-out + 3 no-consent = 5, in one neutral chip.
    expect(within(within(list).getByText('Skipped').closest('div') as HTMLElement).getByText('5')).toBeInTheDocument();
  });

  it('renders the disjoint bucket values exactly as given (no double-count)', () => {
    // A fully delivered 11-recipient broadcast: Delivered 11, everything else 0.
    render(
      <StatChips
        stats={stats({
          audience: 11,
          delivered: 11,
          sent: 0,
          queued: 0,
          failed: 0,
          skipped_opted_out: 0,
          skipped_no_consent: 0,
        })}
      />,
    );
    const list = screen.getByLabelText('Delivery stats');
    expect(chipValue(list, 'Recipients')).toContain('11');
    expect(chipValue(list, 'Delivered')).toContain('11');
    expect(chipValue(list, 'Sent')).toContain('0');
    expect(chipValue(list, 'Queued')).toContain('0');
    expect(chipValue(list, 'Failed')).toContain('0');
    expect(chipValue(list, 'Skipped')).toContain('0');
  });

  it('orders chips Recipients, Delivered, Sent, Queued, Failed, Skipped', () => {
    render(<StatChips stats={stats()} />);
    const list = screen.getByLabelText('Delivery stats');
    const labels = within(list)
      .getAllByRole('term')
      .map((dt) => dt.textContent);
    expect(labels).toEqual(['Recipients', 'Delivered', 'Sent', 'Queued', 'Failed', 'Skipped']);
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

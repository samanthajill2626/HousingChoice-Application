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
import styles from './StatChips.module.css';
import badgeStyles from './DeliveryBadge.module.css';
import pillStyles from './BroadcastStatusPill.module.css';

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
    expect(chipValue(list, 'Sending')).toContain('0');
    expect(chipValue(list, 'Queued')).toContain('0');
    expect(chipValue(list, 'Failed')).toContain('0');
    expect(chipValue(list, 'Skipped')).toContain('0');
  });

  it('orders chips Recipients, Delivered, Sent, Sending, Queued, Failed, Retrying, Not confirmed, Skipped', () => {
    render(<StatChips stats={stats()} />);
    const list = screen.getByLabelText('Delivery stats');
    const labels = within(list)
      .getAllByRole('term')
      .map((dt) => dt.textContent);
    // Two SEPARATE in-flight chips (founder ask, proving out Twilio infra):
    // "Queued" = still on our box (paced fan-out / deferred retry);
    // "Sending" = with the carrier (dispatched, awaiting its sent callback);
    // "Sent" = carrier-confirmed only.
    // "Retrying" (share-sent-outcome D4) sits right after "Failed": the failed
    // recipients holding a live retry promise, split out of Failed.
    // "Not confirmed" (SOR D22) follows: the recipients the platform could not
    // confirm, which are neither failed nor skipped.
    expect(labels).toEqual([
      'Recipients',
      'Delivered',
      'Sent',
      'Sending',
      'Queued',
      'Failed',
      'Retrying',
      'Not confirmed',
      'Skipped',
    ]);
  });

  // share-sent-outcome D4: retry_pending is a SUB-bucket of failed - Failed
  // shows the failures with no live promise, Retrying the ones with one, and
  // the two together are `failed`, so the row still balances.
  it('splits Failed into Failed + Retrying: retry_pending 1 of failed 1 renders Failed 0 and Retrying 1 (progress), and the row balances', () => {
    render(<StatChips stats={stats({ audience: 3, delivered: 1, sent: 0, queued: 0, failed: 2, retry_pending: 1 })} />);
    const list = screen.getByLabelText('Delivery stats');
    expect(chipValue(list, 'Failed')).toBe('Failed1');
    expect(chipValue(list, 'Retrying')).toBe('Retrying1');
    expect(within(list).getByText('Retrying').closest('div')).toHaveClass(styles.progress!);
    const values = within(list)
      .getAllByRole('definition')
      .map((dd) => Number(dd.textContent));
    const [recipients, ...buckets] = values;
    expect(recipients).toBe(3);
    expect(buckets.reduce((sum, v) => sum + v, 0)).toBe(3);
  });

  it('Retrying reads 0 with no progress class when nothing is pending (and for stats without the count)', () => {
    render(<StatChips stats={stats({ failed: 1 })} />);
    const list = screen.getByLabelText('Delivery stats');
    expect(chipValue(list, 'Failed')).toBe('Failed1');
    expect(chipValue(list, 'Retrying')).toBe('Retrying0');
    expect(within(list).getByText('Retrying').closest('div')).not.toHaveClass(styles.progress!);
  });

  it('a kept retry_pending above failed clamps Failed at 0 (never negative)', () => {
    render(<StatChips stats={stats({ failed: 1, retry_pending: 2 })} />);
    const list = screen.getByLabelText('Delivery stats');
    expect(chipValue(list, 'Failed')).toBe('Failed0');
    expect(chipValue(list, 'Retrying')).toBe('Retrying2');
  });

  // SOR D22: the unresolved recipients get their OWN chip in the audience sum -
  // danger, so it draws the eye, but only above zero (the Failed rule) - and
  // never fold into Skipped, which also drives the "Not sent" pill.
  it('renders a Not confirmed chip after Failed, danger only above zero, and keeps the audience sum', () => {
    render(
      <StatChips
        stats={stats({ audience: 4, delivered: 2, sent: 0, queued: 0, failed: 1, unconfirmed: 1 })}
      />,
    );
    const list = screen.getByLabelText('Delivery stats');
    expect(chipValue(list, 'Not confirmed')).toContain('1');
    expect(within(list).getByText('Not confirmed').closest('div')).toHaveClass(styles.danger!);
    expect(chipValue(list, 'Skipped')).toContain('0');
    // The row visibly balances: every bucket chip sums to Recipients.
    const values = within(list)
      .getAllByRole('definition')
      .map((dd) => Number(dd.textContent));
    const [recipients, ...buckets] = values;
    expect(recipients).toBe(4);
    expect(buckets.reduce((sum, v) => sum + v, 0)).toBe(4);
  });

  it('a legacy stats object without the bucket renders 0 with no danger class', () => {
    // stats() carries no `unconfirmed`: persisted rows predate the field.
    render(<StatChips stats={stats()} />);
    const list = screen.getByLabelText('Delivery stats');
    expect(chipValue(list, 'Not confirmed')).toBe('Not confirmed0');
    expect(within(list).getByText('Not confirmed').closest('div')).not.toHaveClass(styles.danger!);
  });

  it('renders the Sending chip from stats.sending, defaulting 0 for legacy rows without it', () => {
    render(<StatChips stats={{ ...stats({ queued: 3 }) }} />);
    const list = screen.getByLabelText('Delivery stats');
    // stats() fixture has no `sending` -> the chip defaults to 0 while Queued
    // still shows its own bucket (legacy persisted rows predate the field).
    expect(chipValue(list, 'Sending')).toContain('0');
    expect(chipValue(list, 'Queued')).toContain('3');
  });

  it('share-skip-fix D7: the Skipped chip also sums skipped_other, defaulting 0 for legacy rows without it', () => {
    const { rerender } = render(<StatChips stats={stats({ skipped_opted_out: 2, skipped_no_consent: 3, skipped_other: 4 })} />);
    expect(chipValue(screen.getByLabelText('Delivery stats'), 'Skipped')).toContain('9');
    rerender(<StatChips stats={stats({ skipped_opted_out: 2, skipped_no_consent: 3 })} />);
    expect(chipValue(screen.getByLabelText('Delivery stats'), 'Skipped')).toContain('5');
  });
});

describe('DeliveryBadge', () => {
  it('renders the queued/sent/delivered status as text', () => {
    const { rerender } = render(<DeliveryBadge status="queued" />);
    expect(screen.getByText('Sending…')).toBeInTheDocument();
    // Dispatched only ('sent' with NO carrierSentAt) is still in flight - the
    // 1:1 bubble for the same message reads "Sending…", so this badge must too.
    rerender(<DeliveryBadge status="sent" />);
    expect(screen.getByText('Sending…')).toBeInTheDocument();
    // The carrier's own sent callback (carrierSentAt) is what flips it to Sent.
    rerender(<DeliveryBadge status="sent" carrierSentAt="2026-07-16T00:00:01.000Z" />);
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

  // (The 30003 promise cases - a row with no promise facts reads the plain
  // failure - moved to DeliveryBadge.test.tsx with share-sent-outcome D3.)

  // POSITION 4 of the four surfaces the fan-out close codes reach
  // (DeliveryBadge.tsx:31). This badge calls the shared deliveryReason with NO
  // options, so the internal map DOES reach it - which is why one string per code
  // has to read as a broadcast results summary as well as on a member's row. A
  // capped broadcast writes the code onto every recipient still queued, so this
  // badge is what an operator reads on the results table.
  it('renders the two fan-out close codes as prose, never as an error number', () => {
    const { rerender, container } = render(
      <DeliveryBadge status="failed" errorCode="transient_cap" />,
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/Sending gave up after repeated temporary errors/)).toBeInTheDocument();
    expect(container.textContent ?? '').not.toContain('(error ');
    expect(container.textContent ?? '').not.toContain('transient_cap');

    rerender(<DeliveryBadge status="failed" errorCode="enqueue_failed" />);
    expect(screen.getByText(/Sending could not be scheduled/)).toBeInTheDocument();
    expect(container.textContent ?? '').not.toContain('(error ');
    expect(container.textContent ?? '').not.toContain('enqueue_failed');
  });

  // SOR D22: a recipient the platform could not confirm reads "Not confirmed"
  // with the D20 reason, danger-toned - never "Failed", never an error number.
  it('renders an unconfirmed recipient as Not confirmed with its reason, never Failed', () => {
    const { container } = render(<DeliveryBadge status="failed" errorCode="send_unconfirmed" />);
    const badge = screen.getByText('Not confirmed');
    expect(badge).toHaveClass(badgeStyles.danger!);
    expect(badge).toHaveAttribute('title', "Couldn't confirm whether this text went out");
    expect(screen.getByText(/Couldn't confirm whether this text went out/)).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    expect(container.textContent ?? '').not.toContain('(error ');
    expect(container.textContent ?? '').not.toContain('send_unconfirmed');
  });

  it('share-skip-fix D7: a skipped row appends its reason, and a code-less legacy skip the disjunction', () => {
    const { rerender } = render(<DeliveryBadge status="skipped" errorCode="manual_mode" />);
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText(/Automatic texts were off for this conversation/)).toBeInTheDocument();
    rerender(<DeliveryBadge status="skipped" errorCode="opted_out" />);
    expect(screen.getByText(/Opted out of texts/)).toBeInTheDocument();
    rerender(<DeliveryBadge status="skipped" />);
    expect(screen.getByText(/Opted out or number unreachable/)).toBeInTheDocument();
  });

  it('share-skip-fix D7: a failed row with no code reads Delivery failed (no raw code, no "error"); no_contact has its own reason', () => {
    const { rerender } = render(<DeliveryBadge status="failed" />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/Delivery failed/)).toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    rerender(<DeliveryBadge status="failed" errorCode="no_contact" />);
    expect(screen.getByText(/No contact or phone on file/)).toBeInTheDocument();
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

  it('share-skip-fix D6: with stats, an all-skipped sent share reads Not sent; a partly delivered one still reads Sent', () => {
    const { rerender } = render(
      <BroadcastStatusPill status="sent" stats={stats({ audience: 1, sent: 0, delivered: 0, queued: 0, skipped_other: 1 })} />,
    );
    expect(screen.getByText('Not sent')).toBeInTheDocument();
    rerender(<BroadcastStatusPill status="sent" stats={stats({ audience: 2, sent: 0, delivered: 1, queued: 0, skipped_other: 1 })} />);
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });

  it('share-sent-outcome D4: a finished share pending a retry reads Sending (progress); Not confirmed and a failure read danger; Failed is never produced with stats', () => {
    const none = { sent: 0, delivered: 0, queued: 0 };
    const { rerender } = render(
      <BroadcastStatusPill status="failed" stats={stats({ ...none, audience: 1, failed: 1, retry_pending: 1 })} />,
    );
    expect(screen.getByText('Sending')).toHaveClass(pillStyles.progress!);
    rerender(<BroadcastStatusPill status="failed" stats={stats({ ...none, audience: 1, unconfirmed: 1 })} />);
    expect(screen.getByText('Not confirmed')).toHaveClass(pillStyles.danger!);
    rerender(<BroadcastStatusPill status="failed" stats={stats({ ...none, audience: 1, failed: 1 })} />);
    expect(screen.getByText('Not sent')).toHaveClass(pillStyles.danger!);
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });
});

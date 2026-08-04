import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScheduledCard } from './ScheduledCard.js';
import type { TimelineScheduled } from '../../api/index.js';

const NOW = Date.parse('2026-06-18T12:00:00Z');

const BASE: TimelineScheduled = {
  kind: 'scheduled',
  id: 'sched-1',
  at: '2026-06-18T15:00:00Z', // 3h in the future
  conversationId: 'c1',
  source: 'tour_reminder',
  reminderKind: 'day_before',
  body: 'Reminder: your tour is tomorrow at 2pm.',
  refType: 'tour',
  refId: 'tour-9',
};

describe('ScheduledCard', () => {
  it('renders the future fire-time line: "sends <relative> - <absolute>" + the body', () => {
    render(<ScheduledCard item={BASE} now={NOW} />);
    // Future branch → "sends in 3h - <absolute>", NOT "sending shortly".
    const fire = screen.getByText(/^sends in 3h - /);
    expect(fire).toBeInTheDocument();
    expect(screen.queryByText(/sending shortly/)).not.toBeInTheDocument();
    expect(screen.getByText('Reminder: your tour is tomorrow at 2pm.')).toBeInTheDocument();
  });

  it('renders "sending shortly" when the fire time is already at/past due', () => {
    const pastDue: TimelineScheduled = { ...BASE, at: '2026-06-18T11:59:00Z' }; // 1m ago
    render(<ScheduledCard item={pastDue} now={NOW} />);
    expect(screen.getByText('sending shortly')).toBeInTheDocument();
    expect(screen.queryByText(/^sends /)).not.toBeInTheDocument();
  });

  it('shows the "Tour reminder" source tag for a tour_reminder', () => {
    render(<ScheduledCard item={BASE} now={NOW} />);
    expect(screen.getByText('Tour reminder')).toBeInTheDocument();
  });

  it('shows the "Nudge" source tag for a placement_nudge', () => {
    const nudge: TimelineScheduled = {
      ...BASE,
      id: 'sched-2',
      source: 'placement_nudge',
      nudgeKind: 'rta_window_closing',
      refType: 'placement',
      refId: 'p-3',
    };
    render(<ScheduledCard item={nudge} now={NOW} />);
    expect(screen.getByText('Nudge')).toBeInTheDocument();
  });

  it('renders an amber "Will be skipped — <reason>" note when suppression is present', () => {
    const suppressed: TimelineScheduled = {
      ...BASE,
      suppression: { reason: 'contact_opted_out' },
    };
    render(<ScheduledCard item={suppressed} now={NOW} />);
    expect(screen.getByText('Will be skipped — contact opted out')).toBeInTheDocument();
  });

  it('maps each suppression reason to its human copy', () => {
    const cases: Array<[NonNullable<TimelineScheduled['suppression']>['reason'], string]> = [
      ['manual_mode', 'conversation in manual mode'],
      ['sms_sending_disabled', 'SMS sending paused'],
      ['stale_stage', 'no longer applies'],
    ];
    for (const [reason, copy] of cases) {
      const { unmount } = render(
        <ScheduledCard item={{ ...BASE, suppression: { reason } }} now={NOW} />,
      );
      expect(screen.getByText(`Will be skipped — ${copy}`)).toBeInTheDocument();
      unmount();
    }
  });

  it('renders NO skip note when suppression is absent', () => {
    render(<ScheduledCard item={BASE} now={NOW} />);
    expect(screen.queryByText(/Will be skipped/)).not.toBeInTheDocument();
  });

  // Quiet hours (2026-08-03) DEFERS the send to quiet-end - it never drops it,
  // so this one reason must NOT reuse the "Will be skipped" sentence.
  // (This table is not exhaustively typed, so the row above would not have
  // caught a missing quiet_hours case - it is asserted explicitly here.)
  it('reads a quiet_hours suppression as a WAIT, never as a skip', () => {
    const EM = String.fromCharCode(0x2014); // rendered em dash, ASCII source
    render(<ScheduledCard item={{ ...BASE, suppression: { reason: 'quiet_hours' } }} now={NOW} />);
    expect(screen.getByText(`Will wait ${EM} quiet hours`)).toBeInTheDocument();
    expect(screen.queryByText(/Will be skipped/)).not.toBeInTheDocument();
  });
});

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

  // Manual-only hold-back (2026-08-20): every fire-time string this card renders
  // is a PROMISE the message goes out then. A held-back rung breaks it, so the
  // line must carry the state instead - a card reading "sends in 6 days" above
  // "Paused - send manually" argues with itself (Cameron hit exactly that).
  it('renders a paused rung as "Paused", never a fire time it will not honour', () => {
    render(
      <ScheduledCard item={{ ...BASE, suppression: { reason: 'paused' } }} now={NOW} />,
    );
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText(/sends in/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sending shortly/)).not.toBeInTheDocument();
    // suppressionNote joins with an EM dash (the placements card is the one
    // surface that composes its own note with a plain hyphen).
    expect(screen.getByText(/Paused . send manually/)).toBeInTheDocument();
  });

  // Discontinued (Phase B): the same equality-then-fallthrough shape as
  // `paused`, one reason further along. A card that can NEVER send must not
  // render a fire-time promise, and must not say "Paused" - that would invite a
  // Send now the job refuses.
  it('renders a discontinued rung as "No longer sent", never a fire time and never Paused', () => {
    render(
      <ScheduledCard item={{ ...BASE, suppression: { reason: 'discontinued' } }} now={NOW} />,
    );
    expect(screen.getByText('No longer sent')).toBeInTheDocument();
    expect(screen.queryByText(/sends in/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sending shortly/)).not.toBeInTheDocument();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    // suppressionNote joins with an EM dash; the label does not repeat the lead.
    expect(screen.getByText(/No longer sent . turned off/)).toBeInTheDocument();
    expect(screen.queryByText(/Will be skipped/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Will wait/)).not.toBeInTheDocument();
  });

  it('a discontinued rung already PAST its fire time does not say "sending shortly"', () => {
    render(
      <ScheduledCard
        item={{ ...BASE, at: '2026-06-18T09:00:00Z', suppression: { reason: 'discontinued' } }}
        now={NOW}
      />,
    );
    expect(screen.getByText('No longer sent')).toBeInTheDocument();
    expect(screen.queryByText(/sending shortly/)).not.toBeInTheDocument();
  });

  // Superseded (supersession 2026-09-01): the tour's ladder was replaced, so
  // this card describes a send that will never happen - the poll claim-skips
  // the rung and Send now answers 409. Same equality-then-fallthrough shape as
  // `discontinued`, and it must not borrow that wording: the KIND still sends,
  // this generation of it does not.
  it('renders a superseded rung as "Replaced", never a fire time', () => {
    render(<ScheduledCard item={{ ...BASE, suppression: { reason: 'superseded' } }} now={NOW} />);
    expect(screen.getByText('Replaced')).toBeInTheDocument();
    expect(screen.queryByText(/sends in/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sending shortly/)).not.toBeInTheDocument();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    expect(screen.queryByText('No longer sent')).not.toBeInTheDocument();
    // suppressionNote joins with an EM dash; the label does not repeat the lead.
    expect(screen.getByText(/Replaced . /)).toBeInTheDocument();
    expect(screen.queryByText(/Will be skipped/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Will wait/)).not.toBeInTheDocument();
  });

  it('a superseded rung already PAST its fire time does not say "sending shortly"', () => {
    render(
      <ScheduledCard
        item={{ ...BASE, at: '2026-06-18T09:00:00Z', suppression: { reason: 'superseded' } }}
        now={NOW}
      />,
    );
    expect(screen.getByText('Replaced')).toBeInTheDocument();
    expect(screen.queryByText(/sending shortly/)).not.toBeInTheDocument();
  });

  // Conversion in flight (review round NEW-3): the card's tour is being turned
  // into a placement, so the poll defers this rung and Send now refuses it. The
  // one TEMPORARY member of the set - it must replace the fire time like the two
  // above, without borrowing a word that declares the rung dead.
  it('renders a claim-in-flight rung as "On hold", never a fire time', () => {
    render(
      <ScheduledCard
        item={{ ...BASE, suppression: { reason: 'conversion_in_progress' } }}
        now={NOW}
      />,
    );
    expect(screen.getByText('On hold')).toBeInTheDocument();
    expect(screen.queryByText(/sends in/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sending shortly/)).not.toBeInTheDocument();
    expect(screen.queryByText('Replaced')).not.toBeInTheDocument();
    expect(screen.queryByText('No longer sent')).not.toBeInTheDocument();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    // suppressionNote joins with an EM dash; the label does not repeat the lead.
    expect(screen.getByText(/On hold . /)).toBeInTheDocument();
    expect(screen.queryByText(/Will be skipped/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Will wait/)).not.toBeInTheDocument();
  });

  it('a claim-in-flight rung already PAST its fire time does not say "sending shortly"', () => {
    render(
      <ScheduledCard
        item={{
          ...BASE,
          at: '2026-06-18T09:00:00Z',
          suppression: { reason: 'conversion_in_progress' },
        }}
        now={NOW}
      />,
    );
    expect(screen.getByText('On hold')).toBeInTheDocument();
    expect(screen.queryByText(/sending shortly/)).not.toBeInTheDocument();
  });

  it('a paused rung already PAST its fire time does not say "sending shortly"', () => {
    render(
      <ScheduledCard
        item={{ ...BASE, at: '2026-06-18T09:00:00Z', suppression: { reason: 'paused' } }}
        now={NOW}
      />,
    );
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText(/sending shortly/)).not.toBeInTheDocument();
  });

  // A client older than its API rendered the literal "Will be skipped -
  // undefined" on a real card. The label lookup now falls back to the raw
  // reason: ugly, but never broken.
  it('an unknown suppression reason degrades to the raw reason, never "undefined"', () => {
    render(
      <ScheduledCard
        item={{
          ...BASE,
          // A reason this bundle predates - the shape a newer API can send.
          suppression: { reason: 'some_future_reason' as never },
        }}
        now={NOW}
      />,
    );
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    expect(screen.getByText(/some_future_reason/)).toBeInTheDocument();
  });

  it('renders the absolute fire time in the zone the body was composed in', () => {
    // Spec D8: the body now quotes an ORG-local time, so the absolute half of
    // the fire line must use the SAME zone or the card contradicts itself.
    // Asia/Tokyo is nobody's plausible browser zone here, so this cannot pass by
    // accident: 2026-06-18T15:00Z is 12:00 AM on Jun 19 in Tokyo.
    render(<ScheduledCard item={BASE} now={NOW} timezone="Asia/Tokyo" />);
    // The GMT+9 suffix is the FOREIGN-ZONE MARKER: because Tokyo is not this
    // runner's own zone, the time is labelled so a reader cannot mistake it for
    // their own clock. An org-zone navigator - every Housing Choice navigator
    // today - gets no marker at all (pinned in placementsFormat.test.ts).
    expect(screen.getByText('sends in 3h - Jun 19, 12:00 AM GMT+9')).toBeInTheDocument();
  });

  it('falls back to the browser zone when no zone is supplied', () => {
    // A response that predates the field (or a failed bucket fetch) must render
    // exactly as it does today, never crash and never show an empty time.
    const legacy = new Date(BASE.at).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    render(<ScheduledCard item={BASE} now={NOW} />);
    expect(screen.getByText(`sends in 3h - ${legacy}`)).toBeInTheDocument();
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

  // The twin of RemindersPanel's blank-preview note. A tour-reminder card whose
  // body the server WITHHELD (a read the copy needed threw, so the preview
  // would otherwise show text the send never produces) must say so rather than
  // render an empty line under a "Tour reminder" tag.
  it('a withheld tour-reminder body renders the "Preview unavailable" note', () => {
    render(<ScheduledCard item={{ ...BASE, body: '' }} now={NOW} />);
    expect(
      screen.getByText('Preview unavailable - this message cannot be composed right now.'),
    ).toBeInTheDocument();
  });

  // Scoped to tour reminders: nudge bodies come from a different composer with
  // no withhold rule, so an empty one is not this sentence's story.
  it('an empty NUDGE body gets no note', () => {
    render(
      <ScheduledCard
        item={{
          ...BASE,
          body: '',
          source: 'placement_nudge',
          nudgeKind: 'rta_window_closing',
          refType: 'placement',
          refId: 'p-3',
        }}
        now={NOW}
      />,
    );
    expect(screen.queryByText(/Preview unavailable/)).not.toBeInTheDocument();
  });
});

// RemindersPanel component tests — verify:
//   - the ladder fetches on mount and renders a titled "Reminders" region
//   - each rung shows its human kind label, state chip, and body
//   - the NEXT rung is highlighted (aria-current + "Next" tag)
//   - a suppression renders the "Will be skipped — <reason>" note
//   - an empty ladder → "No reminders armed."
//   - a scheduled.updated / same-tour tour.updated SSE event refetches the ladder
//
// Pattern mirrors TourDetail.test.tsx: mock the api barrel, import after mocking,
// assert accessibility-first. The SSE capture mirrors useTourActivity.test.tsx.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../../api/index.js';
import type {
  EventStreamHandlers,
  TourReminderEarlierView,
  TourReminderView,
  TourRemindersPage,
} from '../../api/index.js';

const getTourReminders = vi.fn();
const patchTourReminder = vi.fn();
const postReminderSendNow = vi.fn();
let streamHandlers: EventStreamHandlers | null = null;
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getTourReminders: (...a: unknown[]) => getTourReminders(...a),
    patchTourReminder: (...a: unknown[]) => patchTourReminder(...a),
    postReminderSendNow: (...a: unknown[]) => postReminderSendNow(...a),
    useEventStream: (h: EventStreamHandlers) => {
      streamHandlers = h;
    },
  };
});

import { nextReminderRefetchDelay, RemindersPanel } from './RemindersPanel.js';

function rung(over: Partial<TourReminderView> = {}): TourReminderView {
  return {
    reminderId: 'r-1',
    kind: 'day_before',
    dueAt: '2999-01-01T12:00:00Z',
    state: 'upcoming',
    body: 'Your tour is tomorrow at 2pm.',
    ...over,
  };
}

/** A rung of a ladder this tour has already replaced (supersession S7). NO
 *  `body` by default - most earlier rungs predate the snapshot field, and
 *  "there is nothing honest to show" is the default this projection has. */
function earlierRung(over: Partial<TourReminderEarlierView> = {}): TourReminderEarlierView {
  return {
    reminderId: 'e-1',
    kind: 'day_before',
    dueAt: '2026-01-01T12:00:00Z',
    state: 'sent',
    sentAt: '2026-01-01T12:00:03Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  postReminderSendNow.mockReset().mockResolvedValue(rung({ state: 'sent' }));
  streamHandlers = null;
});

describe('RemindersPanel', () => {
  it('renders a "Reminders" Card heading', async () => {
    getTourReminders.mockResolvedValue({ reminders: [] } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    // Restyled INTO a <Card title="Reminders"> (an h3), not a named region.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Reminders/i })).toBeInTheDocument(),
    );
    expect(getTourReminders).toHaveBeenCalledWith('tour-1', expect.anything());
  });

  it('shows "No reminders armed." for an empty ladder', async () => {
    getTourReminders.mockResolvedValue({ reminders: [] } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(/No reminders armed/i)).toBeInTheDocument());
  });

  it('renders each rung with its human kind label and body', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-1', kind: 'confirmation', body: 'Reply YES to confirm.' }),
        rung({ reminderId: 'r-2', kind: 'no_show_checkin', body: 'Everything OK?' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Confirmation')).toBeInTheDocument());
    expect(screen.getByText('No-show check-in')).toBeInTheDocument();
    expect(screen.getByText('Reply YES to confirm.')).toBeInTheDocument();
    expect(screen.getByText('Everything OK?')).toBeInTheDocument();
  });

  it('shows a sent rung with its sent-at time and an upcoming rung as amber', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-1', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
        rung({ reminderId: 'r-2', kind: 'day_before', state: 'upcoming' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Confirmation')).toBeInTheDocument());
    expect(screen.getByText(/Sent -/i)).toBeInTheDocument();
  });

  it('stamps the sent chip in the zone the LIST response composed the bodies in', async () => {
    // Spec D8: the body beside this chip quotes an ORG-local time, so the chip
    // has to use the response's zone rather than the navigator's browser zone.
    // Asia/Tokyo is nobody's plausible browser zone here, so the assertion
    // cannot pass by accident: 2026-06-18T13:02Z is 10:02 PM the same day there.
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-1', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
      ],
      timezone: 'Asia/Tokyo',
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    // GMT+9 is the FOREIGN-ZONE MARKER (S1): Tokyo is not this runner's own
    // zone, so the chip is labelled rather than left to read as the viewer's
    // clock. An org-zone navigator sees no marker - pinned in
    // placementsFormat.test.ts, which is what keeps this from becoming noise.
    await waitFor(() =>
      expect(screen.getByText('Sent - Jun 18, 10:02 PM GMT+9')).toBeInTheDocument(),
    );
  });

  it('falls back to the browser zone when the response carries no zone', async () => {
    // A stale cached response (or an older backend) must render exactly as it
    // does today - never a crash, never an empty time.
    const legacy = new Date('2026-06-18T13:02:00Z').toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-1', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(`Sent - ${legacy}`)).toBeInTheDocument());
  });

  it('a claim-skipped rung reads "Skipped - <reason>" (plain hyphen), never "sending shortly"', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'confirmation',
          state: 'skipped',
          skippedAt: '2026-07-13T16:00:00Z',
          skipReason: 'no_conversation',
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText('Skipped - no conversation')).toBeInTheDocument(),
    );
    // The retired rung must never keep the amber "sending shortly" lie.
    expect(screen.queryByText(/sending shortly/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sends in/i)).not.toBeInTheDocument();
  });

  it('a rung skipped as booked_too_late names the reason, not a bare "Skipped"', async () => {
    // Arm-time skip reason (spec 2026-08-26 section 8.2). Omitting the wire
    // union member does not fail a build - the chip degrades silently to a
    // reason-less "Skipped", which reads as a bug in the ladder rather than a
    // missing label. This test is what catches that.
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'day_before',
          state: 'skipped',
          skippedAt: '2026-07-13T16:00:00Z',
          skipReason: 'booked_too_late',
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(
        screen.getByText('Skipped - booked too late for this reminder'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Skipped')).not.toBeInTheDocument();
  });

  it('an upcoming rung reads "sends in" (a reminder is sent, not "due")', async () => {
    getTourReminders.mockResolvedValue({
      // Far-future dueAt → sendRelative yields "sends in Nd".
      reminders: [rung({ reminderId: 'r-1', kind: 'day_before', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(/sends in/i)).toBeInTheDocument());
    // Reminders never use the deadline wording.
    expect(screen.queryByText(/due in/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
  });

  it('an upcoming rung whose fire time has passed reads "sending shortly"', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-1', kind: 'morning_of', state: 'upcoming', dueAt: '2000-01-01T00:00:00Z' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(/sending shortly/i)).toBeInTheDocument());
  });

  it('highlights the NEXT rung with aria-current and a "Next" tag', async () => {
    const next = rung({ reminderId: 'r-2', kind: 'morning_of' });
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-1', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }), next],
      next,
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('4 hours before')).toBeInTheDocument());
    const nextRow = screen.getByText('4 hours before').closest('li');
    expect(nextRow).not.toBeNull();
    expect(nextRow).toHaveAttribute('aria-current', 'step');
    expect(within(nextRow as HTMLElement).getByText('Next')).toBeInTheDocument();
  });

  it('renders a "Will be skipped — <reason>" note when a rung is suppressed', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-1', suppression: { reason: 'contact_opted_out' } })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText(/Will be skipped — contact opted out/i)).toBeInTheDocument(),
    );
  });

  // Manual-only hold-back (founder decision 2026-08-20): a paused rung is NOT
  // being dropped and is NOT waiting on a clock, so it must borrow neither the
  // "Will be skipped" nor the "Will wait" wording - and it must never keep the
  // "sending shortly" chip, which is the perpetual-lie failure claimSkip exists
  // to prevent.
  it('renders a paused rung as "Paused — send manually", never as skipped or waiting', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'day_before',
          state: 'upcoming',
          // Past its fire time: without the paused note this row would chip
          // "sending shortly" forever, because the poll will never claim it.
          dueAt: '2000-01-01T00:00:00Z',
          suppression: { reason: 'paused' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText(/Paused — send manually/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Will be skipped/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Will wait/i)).not.toBeInTheDocument();
    // The CHIP must agree with the note. A row that chips "sending shortly"
    // while the line under it says "Paused" is the contradiction this whole
    // change exists to remove - and the chip is the part people read first.
    expect(screen.queryByText(/sending shortly/i)).not.toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('a paused rung that is still in the FUTURE does not promise "sends in Nh" either', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'day_before',
          state: 'upcoming',
          dueAt: '2099-01-09T10:00:00Z',
          suppression: { reason: 'paused' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Paused')).toBeInTheDocument());
    expect(screen.queryByText(/sends in/i)).not.toBeInTheDocument();
  });

  // Discontinued (Phase B): the chip must NOT fall through to the fire-time
  // promise, and must not borrow the Paused wording either - "Paused" invites a
  // Send now that the job refuses with kind_retired.
  //
  // CHIP ORDER: this branch sits ABOVE `paused`, and the `overdue` chip (when it
  // lands) must sit BELOW this one - a rung that will never send is never
  // "overdue".
  it('renders a discontinued rung as "No longer sent", never a fire time and never Paused', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'confirmation',
          state: 'upcoming',
          // Past its fire time: the fallthrough would chip "sending shortly"
          // forever on a rung nothing will ever claim.
          dueAt: '2000-01-01T00:00:00Z',
          suppression: { reason: 'discontinued' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('No longer sent')).toBeInTheDocument());
    expect(screen.queryByText(/sending shortly/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    // The note underneath carries the other half, without stuttering.
    expect(screen.getByText(/No longer sent . turned off/)).toBeInTheDocument();
    expect(screen.queryByText(/Will be skipped/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Will wait/i)).not.toBeInTheDocument();
    // ...and NO "Send now" (review round 1, B-S1). The chip changed to stop
    // inviting a click the server can only refuse (409 kind_retired, permanently
    // and by design); the affordance has to follow it. Cancel/Restore stay: a
    // discontinued rung is still a pending row an operator may want off the
    // ladder.
    expect(screen.queryByRole('button', { name: /Send the/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel the/ })).toBeInTheDocument();
  });

  it('ANTI-VACUITY for the above: a plain upcoming rung DOES offer Send now', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-1', kind: 'confirmation', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Send the/ })).toBeInTheDocument(),
    );
  });

  it('a discontinued rung still in the FUTURE does not promise "sends in Nh" either', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'confirmation',
          state: 'upcoming',
          dueAt: '2099-01-09T10:00:00Z',
          suppression: { reason: 'discontinued' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('No longer sent')).toBeInTheDocument());
    expect(screen.queryByText(/sends in/i)).not.toBeInTheDocument();
  });

  // SUPERSEDED (supersession spec 3.3): the rung belongs to a ladder the tour
  // has already replaced. Every send path refuses it - the poll claim-skips it
  // and Send now answers 409 - so the panel must neither promise a fire time
  // nor offer the click. Distinct chip from "No longer sent": that one says the
  // KIND is retired, this one says THIS generation is.
  it('renders a superseded rung as "Replaced", never a fire time and with no Send now', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'day_before',
          state: 'upcoming',
          // Past due: the fall-through would chip "sending shortly" forever on
          // a rung nothing will ever claim.
          dueAt: '2000-01-01T00:00:00Z',
          suppression: { reason: 'superseded' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Replaced')).toBeInTheDocument());
    expect(screen.queryByText(/sending shortly/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    expect(screen.queryByText('No longer sent')).not.toBeInTheDocument();
    // The rung will never send, so it is never "overdue" either.
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    // The note underneath carries the why, without repeating the lead.
    expect(screen.getByText(/Replaced . /)).toBeInTheDocument();
    expect(screen.queryByText(/Will be skipped/i)).not.toBeInTheDocument();
    // No Send now (the server refuses it 409 superseded); Cancel stays, because
    // a superseded rung the sweep missed is still a row an operator may remove.
    expect(screen.queryByRole('button', { name: /Send the/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel the/ })).toBeInTheDocument();
  });

  // The retired half of the same story: once the poll has claim-skipped a rung
  // for a conversion claim that never finished, the chip has to say WHICH
  // failure it was - a reason-less "Skipped" sends the operator hunting.
  it('names conversion_stalled on a skipped rung instead of a bare "Skipped"', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'morning_of',
          state: 'skipped',
          skippedAt: '2026-09-01T12:00:00Z',
          skipReason: 'conversion_stalled',
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText(/^Skipped - .+/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/conversion/i)).toBeInTheDocument();
    expect(screen.queryByText('Skipped')).not.toBeInTheDocument();
  });

  // The same for a rung retired because its ladder was replaced.
  it('names superseded on a skipped rung instead of a bare "Skipped"', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'morning_of',
          state: 'skipped',
          skippedAt: '2026-09-01T12:00:00Z',
          skipReason: 'superseded',
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(/^Skipped - .+/)).toBeInTheDocument());
    expect(screen.queryByText('Skipped')).not.toBeInTheDocument();
  });

  // OVERDUE (Phase B spec 8). The server derives it - the panel never compares
  // clocks itself - and it exists because `state` is computed from terminal
  // markers alone, so a rung stuck behind any pre-claim deferral reads
  // "upcoming" with a dueAt weeks in the past and the chip keeps promising a
  // send. "Sending shortly" on a rung that has been sending shortly for a
  // fortnight is the same lie in a politer register.
  it('replaces the fire-time promise with an Overdue chip when the server says overdue', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'day_before',
          state: 'upcoming',
          dueAt: '2000-01-01T00:00:00Z',
          overdue: true,
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Overdue')).toBeInTheDocument());
    // The promise this chip replaces.
    expect(screen.queryByText(/sending shortly/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sends in/i)).not.toBeInTheDocument();
  });

  it('an overdue rung still renders its suppression note alongside the chip', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'day_before',
          state: 'upcoming',
          dueAt: '2000-01-01T00:00:00Z',
          overdue: true,
          suppression: { reason: 'quiet_hours' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Overdue')).toBeInTheDocument());
    // COMPOSES rather than competes (spec 8.1): the chip says the send time has
    // passed, the note says WHY nothing has gone out.
    expect(screen.getByText(/Will wait . quiet hours/i)).toBeInTheDocument();
  });

  // CHIP ORDER (worklist R15): discontinued is ABOVE overdue. A rung nothing
  // will ever send is not "overdue" - it is finished, and "Overdue" would read
  // as something a navigator can chase.
  it('a discontinued rung that is ALSO overdue still reads "No longer sent"', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'confirmation',
          state: 'upcoming',
          dueAt: '2000-01-01T00:00:00Z',
          overdue: true,
          suppression: { reason: 'discontinued' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('No longer sent')).toBeInTheDocument());
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });

  // ...and the other side of the order: overdue is ABOVE paused, so a rung a
  // human still has to send by hand says so with the urgency it has earned.
  it('an overdue rung that is ALSO paused chips Overdue, and keeps the paused note', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'day_before',
          state: 'upcoming',
          dueAt: '2000-01-01T00:00:00Z',
          overdue: true,
          suppression: { reason: 'paused' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Overdue')).toBeInTheDocument());
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    expect(screen.getByText(/Paused . send manually/i)).toBeInTheDocument();
  });

  it('keeps Send now on a paused rung (the whole point of leaving it pending)', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-1',
          kind: 'day_before',
          state: 'upcoming',
          suppression: { reason: 'paused' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Day before')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Send the Day before reminder now/i })).toBeEnabled();
  });

  it('surfaces a fetch error via role="alert"', async () => {
    getTourReminders.mockRejectedValue(new ApiError(500, 'boom', 'boom'));
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('refetches on a scheduled.updated event (arm/reschedule/cancel goes live)', async () => {
    // Book-a-tour repro: mounts with no reminders, the ladder arms server-side,
    // scheduled.updated fires -> the panel refetches and shows the fresh rung.
    getTourReminders.mockResolvedValueOnce({ reminders: [] } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText(/No reminders armed/i)).toBeInTheDocument());
    expect(getTourReminders).toHaveBeenCalledTimes(1);

    getTourReminders.mockResolvedValueOnce({
      reminders: [rung({ reminderId: 'r-1', kind: 'day_before' })],
    } satisfies TourRemindersPage);
    // The payload carries no tourId (advisory contactId only) -> refetch on any.
    act(() => streamHandlers?.onScheduledUpdated?.({}));
    await waitFor(() => expect(getTourReminders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Day before')).toBeInTheDocument());
  });

  it('refetches on a tour.updated for THIS tour, ignores other tours', async () => {
    // Mark-toured repro: the pending rung must flip to Canceled without a reload.
    getTourReminders.mockResolvedValueOnce({
      reminders: [rung({ reminderId: 'r-1', kind: 'day_before', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Day before')).toBeInTheDocument());
    expect(getTourReminders).toHaveBeenCalledTimes(1);

    act(() => streamHandlers?.onTourUpdated?.({ tourId: 'other-tour', status: 'toured' }));
    expect(getTourReminders).toHaveBeenCalledTimes(1);

    getTourReminders.mockResolvedValueOnce({
      reminders: [rung({ reminderId: 'r-1', kind: 'day_before', state: 'canceled' })],
    } satisfies TourRemindersPage);
    act(() => streamHandlers?.onTourUpdated?.({ tourId: 'tour-1', status: 'toured' }));
    await waitFor(() => expect(getTourReminders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Canceled')).toBeInTheDocument());
  });
});

// ---- The dueAt-anchored self-refetch (worker-fire liveness) -----------------
// A rung FIRING happens in the worker process, whose SSE events never reach the
// browser (the lib/events.ts seam) — the panel anchors its own refetch to the
// next rung's dueAt instead.

describe('nextReminderRefetchDelay (pure)', () => {
  const NOW = new Date('2026-07-10T12:00:00Z').getTime();

  it('returns null when no rung is upcoming (nothing to wait for)', () => {
    expect(nextReminderRefetchDelay([], NOW)).toBeNull();
    expect(
      nextReminderRefetchDelay(
        [
          { state: 'sent', dueAt: '2026-07-10T11:00:00Z' },
          { state: 'canceled', dueAt: '2026-07-10T13:00:00Z' },
          // A claim-skipped rung is terminal — no timer, even when past-due.
          { state: 'skipped', dueAt: '2026-07-10T11:30:00Z' },
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it('anchors just past the EARLIEST upcoming dueAt', () => {
    const delay = nextReminderRefetchDelay(
      [
        { state: 'upcoming', dueAt: '2026-07-10T14:00:00Z' },
        { state: 'upcoming', dueAt: '2026-07-10T12:00:30Z' },
      ],
      NOW,
    );
    // 30s to the earliest fire + the 2s buffer.
    expect(delay).toBe(32_000);
  });

  it('re-checks on a short interval while a due rung awaits the worker poll', () => {
    expect(
      nextReminderRefetchDelay([{ state: 'upcoming', dueAt: '2026-07-10T11:59:00Z' }], NOW),
    ).toBe(20_000);
  });

  it('clamps a far-future anchor (each landed fetch re-anchors anyway)', () => {
    expect(
      nextReminderRefetchDelay([{ state: 'upcoming', dueAt: '2026-08-01T12:00:00Z' }], NOW),
    ).toBe(6 * 3_600_000);
  });

  // Review round 1, B-S2. The 20s overdue re-check assumes the worker will flip
  // the rung within a tick or two. A DISCONTINUED rung never flips, so a tab
  // left open on a tour with a pause-era confirmation would hammer
  // GET /api/tours/:id/reminders every 20 seconds forever - a route that reads
  // the tour, the unit, two contacts, settings and the whole ladder per request.
  it('ignores a discontinued rung entirely - it will never flip, so there is nothing to wait for', () => {
    expect(
      nextReminderRefetchDelay(
        [
          {
            state: 'upcoming',
            dueAt: '2026-07-10T11:00:00Z',
            suppression: { reason: 'discontinued' },
          },
        ],
        NOW,
      ),
    ).toBeNull();
  });

  it('a discontinued rung does not shadow a LIVE one behind it', () => {
    expect(
      nextReminderRefetchDelay(
        [
          // Earliest, and permanently stuck - it must not win the anchor.
          {
            state: 'upcoming',
            dueAt: '2026-07-10T11:00:00Z',
            suppression: { reason: 'discontinued' },
          },
          { state: 'upcoming', dueAt: '2026-07-10T12:00:30Z' },
          // A PAUSED rung is NOT skipped: a human can still send it, so the
          // panel keeps re-checking for that flip.
          { state: 'upcoming', dueAt: '2026-07-10T18:00:00Z', suppression: { reason: 'paused' } },
        ],
        NOW,
      ),
    ).toBe(32_000);
  });

  // A SUPERSEDED rung never flips either: the poll claim-skips it the moment it
  // is picked up and Send now refuses it, so anchoring the 20s overdue
  // re-check on one is the same unbounded poll the discontinued case above
  // closed. It reaches the panel on a rung the sweep missed, which is exactly
  // the row that sits past-due indefinitely.
  it('ignores a superseded rung entirely, and lets a live rung behind it anchor', () => {
    expect(
      nextReminderRefetchDelay(
        [
          {
            state: 'upcoming',
            dueAt: '2026-07-10T11:00:00Z',
            suppression: { reason: 'superseded' },
          },
        ],
        NOW,
      ),
    ).toBeNull();
    expect(
      nextReminderRefetchDelay(
        [
          {
            state: 'upcoming',
            dueAt: '2026-07-10T11:00:00Z',
            suppression: { reason: 'superseded' },
          },
          { state: 'upcoming', dueAt: '2026-07-10T12:00:30Z' },
        ],
        NOW,
      ),
    ).toBe(32_000);
  });
});

describe('RemindersPanel — dueAt-anchored self-refetch', () => {
  it('refetches on its own just after the next rung fires, then stops once nothing is upcoming', async () => {
    vi.useRealTimers(); // release the global Date pin (test/setup.ts) first
    vi.useFakeTimers();
    try {
      const soon = new Date(Date.now() + 5_000).toISOString();
      getTourReminders
        .mockResolvedValueOnce({ reminders: [rung({ dueAt: soon })] } satisfies TourRemindersPage)
        .mockResolvedValue({
          reminders: [rung({ dueAt: soon, state: 'sent', sentAt: soon })],
        } satisfies TourRemindersPage);
      render(<RemindersPanel tourId="tour-1" />);

      // Initial fetch lands (flush microtasks under fake timers).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getTourReminders).toHaveBeenCalledTimes(1);

      // Past dueAt + the fire buffer → the anchored timer refetches, and the
      // fresh ladder shows the rung as sent. No SSE event was involved.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });
      expect(getTourReminders).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/Sent/)).toBeInTheDocument();

      // Nothing upcoming anymore → no further self-refetch is armed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60 * 60_000);
      });
      expect(getTourReminders).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Operator cancel/restore (2026-07-14). mockReset (not just clearAllMocks —
  // that leaves queued mockResolvedValueOnce values behind for the NEXT test).
  it('Cancel on an upcoming rung PATCHes {canceled:true} and refetches; Restore reverses it', async () => {
    getTourReminders.mockReset();
    patchTourReminder.mockReset();
    getTourReminders
      .mockResolvedValueOnce({
        reminders: [rung({ reminderId: 'r-c', kind: 'day_before', state: 'upcoming' })],
      } satisfies TourRemindersPage)
      .mockResolvedValueOnce({
        reminders: [
          rung({
            reminderId: 'r-c',
            kind: 'day_before',
            state: 'canceled',
            canceledAt: '2026-07-14T10:00:00Z',
          }),
        ],
      } satisfies TourRemindersPage)
      .mockResolvedValue({
        reminders: [rung({ reminderId: 'r-c', kind: 'day_before', state: 'upcoming' })],
      } satisfies TourRemindersPage);
    patchTourReminder.mockResolvedValue(rung({ reminderId: 'r-c', state: 'canceled' }));

    render(<RemindersPanel tourId="tour-1" />);
    const cancelBtn = await screen.findByRole('button', { name: 'Cancel the Day before reminder' });
    cancelBtn.click();
    await waitFor(() =>
      expect(patchTourReminder).toHaveBeenCalledWith('tour-1', 'r-c', true),
    );
    // The post-PATCH refetch shows the canceled chip + a Restore action.
    const restoreBtn = await screen.findByRole('button', { name: 'Restore the Day before reminder' });
    expect(screen.getByText('Canceled')).toBeInTheDocument();

    patchTourReminder.mockClear();
    patchTourReminder.mockResolvedValue(rung({ reminderId: 'r-c', state: 'upcoming' }));
    restoreBtn.click();
    await waitFor(() =>
      expect(patchTourReminder).toHaveBeenCalledWith('tour-1', 'r-c', false),
    );
    await screen.findByRole('button', { name: 'Cancel the Day before reminder' });
  });

  it('a sent rung offers NO cancel/restore action', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-s', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Confirmation')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Cancel|Restore/ })).toBeNull();
  });
});

// ---- Quiet hours (2026-08-03): the deferred-send chip + operator Send now ----
// Quiet hours DEFERS a rung, it never drops it, so its note must not read
// "Will be skipped"; and staff can force any PENDING rung out immediately.

// The rendered em dash, by code point, so these added source lines stay ASCII.
const EM = String.fromCharCode(0x2014);

describe('RemindersPanel - quiet-hours copy', () => {
  it('a quiet_hours suppression reads as a WAIT, never as a skip', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-q', suppression: { reason: 'quiet_hours' } })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText(`Will wait ${EM} quiet hours`)).toBeInTheDocument(),
    );
    // "Will be skipped" would be a lie - the message goes out at quiet-end.
    expect(screen.queryByText(/Will be skipped/)).toBeNull();
  });

  it('every OTHER suppression reason keeps the "Will be skipped" sentence', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-o', suppression: { reason: 'manual_mode' } })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText(`Will be skipped ${EM} manual mode`)).toBeInTheDocument(),
    );
  });

  it('a rung retired by release supersession names that reason in its chip', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({
          reminderId: 'r-sup',
          kind: 'day_before',
          state: 'skipped',
          skippedAt: '2026-07-13T16:00:00Z',
          skipReason: 'quiet_hours_superseded',
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() =>
      expect(screen.getByText('Skipped - superseded by a later reminder')).toBeInTheDocument(),
    );
  });
});

describe('RemindersPanel - Send now', () => {
  it('offers Send now on an upcoming rung only (not sent/canceled/skipped)', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [
        rung({ reminderId: 'r-u', kind: 'day_before', state: 'upcoming' }),
        rung({ reminderId: 'r-s', kind: 'confirmation', state: 'sent', sentAt: '2026-06-18T13:02:00Z' }),
        rung({ reminderId: 'r-c', kind: 'morning_of', state: 'canceled', canceledAt: '2026-06-18T13:02:00Z' }),
        rung({ reminderId: 'r-k', kind: 'en_route', state: 'skipped', skippedAt: '2026-06-18T13:02:00Z' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);

    // Accessible name disambiguates the rung (A10) - a bare "Send now" repeated
    // per rung would be a strict-mode violation for the e2e harness.
    await screen.findByRole('button', { name: 'Send the Day before reminder now' });
    expect(screen.getAllByRole('button', { name: /reminder now$/ })).toHaveLength(1);
    // Visible text stays short.
    expect(screen.getByText('Send now')).toBeInTheDocument();
  });

  it('Send now POSTs for that rung and refetches the honest ladder', async () => {
    getTourReminders.mockReset();
    getTourReminders
      .mockResolvedValueOnce({
        reminders: [rung({ reminderId: 'r-n', kind: 'day_before', state: 'upcoming' })],
      } satisfies TourRemindersPage)
      .mockResolvedValue({
        reminders: [
          rung({
            reminderId: 'r-n',
            kind: 'day_before',
            state: 'sent',
            sentAt: '2026-07-01T12:00:00Z',
          }),
        ],
      } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);

    const btn = await screen.findByRole('button', { name: 'Send the Day before reminder now' });
    btn.click();
    await waitFor(() => expect(postReminderSendNow).toHaveBeenCalledWith('tour-1', 'r-n'));
    await waitFor(() => expect(getTourReminders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/Sent -/i)).toBeInTheDocument());
    // A success clears any error slot.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a 409 shows readable inline copy beside the rung, keeps the ladder, and re-enables', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-e', kind: 'day_before', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    postReminderSendNow.mockReset();
    postReminderSendNow.mockRejectedValue(
      new ApiError(409, 'contact_opted_out', 'contact_opted_out', {
        error: 'contact_opted_out',
      }),
    );
    render(<RemindersPanel tourId="tour-1" />);

    const btn = await screen.findByRole('button', { name: 'Send the Day before reminder now' });
    btn.click();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/opted out/i);
    // The raw machine code never reaches a navigator.
    expect(alert).not.toHaveTextContent('contact_opted_out');
    // The list must NOT be replaced by the error (the fetch-error path does that).
    expect(screen.getByText('Day before')).toBeInTheDocument();
    const again = await screen.findByRole('button', { name: 'Send the Day before reminder now' });
    expect((again as HTMLButtonElement).disabled).toBe(false);
  });

  it('a contact_deleted 409 tells the navigator to restore the contact', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-d', kind: 'day_before', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    postReminderSendNow.mockReset();
    postReminderSendNow.mockRejectedValue(
      new ApiError(409, 'contact_deleted', 'contact_deleted', { error: 'contact_deleted' }),
    );
    render(<RemindersPanel tourId="tour-1" />);

    (await screen.findByRole('button', { name: 'Send the Day before reminder now' })).click();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/restore them to send/i);
    // The raw machine code never reaches a navigator.
    expect(alert).not.toHaveTextContent('contact_deleted');
  });

  it('an unmapped refusal code still says something human', async () => {
    getTourReminders.mockReset();
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-x', kind: 'day_before', state: 'upcoming' })],
    } satisfies TourRemindersPage);
    postReminderSendNow.mockReset();
    postReminderSendNow.mockRejectedValue(new ApiError(409, 'wat_is_this', 'wat_is_this'));
    render(<RemindersPanel tourId="tour-1" />);

    (await screen.findByRole('button', { name: 'Send the Day before reminder now' })).click();
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('wat_is_this');
    expect(alert).toHaveTextContent(/try again/i);
  });

  // GIVE THE BLANK A SENTENCE. `body: ''` has two producers server-side (an
  // unusable scheduledAt, and the new entry-fork withhold), and both leave Send
  // now refusing - so a bare empty paragraph beside a LIVE Send-now button
  // reads as a broken app rather than a degraded read.
  it('an empty body renders the "Preview unavailable" note, not bare emptiness', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-blank', kind: 'day_before', state: 'upcoming', body: '' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);

    expect(
      await screen.findByText('Preview unavailable - this message cannot be composed right now.'),
    ).toBeInTheDocument();
    // The rest of the row is untouched: the rung is still listed and still
    // sendable by hand.
    expect(screen.getByText('Day before')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send the Day before reminder now' }),
    ).toBeInTheDocument();
  });
});

// ===========================================================================
// EARLIER REMINDERS - the collapsed disclosure (supersession spec 3.4, S7).
//
// A rescheduled or converted tour leaves survivors of the generation it
// replaced. They are history, not a promise, so they sit BEHIND a disclosure
// that is closed by default (decision D2: out of the default view) and below
// the current ladder - including when the current ladder is EMPTY, which is
// exactly what a terminal tour looks like.
// ===========================================================================
describe('RemindersPanel - earlier reminders disclosure', () => {
  it('renders BOTH "No reminders armed." and the disclosure when the current ladder is empty', async () => {
    // T7.3 / acceptance 10. The empty-ladder short-circuit at the top of the
    // Card returns a single paragraph, so a disclosure written inside that
    // ternary would be invisible on exactly the tour that has the most to
    // show. Asserted on the RENDER, never on a derived flag.
    getTourReminders.mockResolvedValue({
      reminders: [],
      earlier: [
        earlierRung({ reminderId: 'e-1', kind: 'day_before' }),
        earlierRung({ reminderId: 'e-2', kind: 'morning_of' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);

    await waitFor(() => expect(screen.getByText(/No reminders armed/i)).toBeInTheDocument());
    expect(screen.getByText('Earlier reminders (2)')).toBeInTheDocument();
  });

  it('is COLLAPSED by default and reveals its rows on click', async () => {
    // T7.4. Every other assertion in this file passes just as well against an
    // always-open block, so the default state needs its own case.
    getTourReminders.mockResolvedValue({
      reminders: [],
      earlier: [earlierRung({ reminderId: 'e-1', kind: 'day_before' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);

    const summary = await screen.findByText('Earlier reminders (1)');
    // The content is in the DOM but NOT visible - a closed <details>.
    expect(screen.getByText('Day before')).not.toBeVisible();

    fireEvent.click(summary);
    expect(screen.getByText('Day before')).toBeVisible();
  });

  it('allowlists actions BY STATE: only a sweep-missed upcoming rung offers Cancel', async () => {
    // T7.5 / spec 3.4's table. The current ladder's action list keys off
    // `state` alone, so inheriting it would put Send now on an unsent earlier
    // rung and Restore on a canceled one - resurrecting a rung into a ladder
    // that no longer exists.
    getTourReminders.mockResolvedValue({
      reminders: [],
      earlier: [
        earlierRung({ reminderId: 'e-sent', kind: 'confirmation', state: 'sent' }),
        earlierRung({
          reminderId: 'e-upcoming',
          kind: 'day_before',
          state: 'upcoming',
          sentAt: undefined,
          suppression: { reason: 'superseded' },
        }),
        earlierRung({
          reminderId: 'e-canceled',
          kind: 'morning_of',
          state: 'canceled',
          sentAt: undefined,
          canceledAt: '2026-01-01T09:00:00Z',
        }),
        earlierRung({
          reminderId: 'e-skipped',
          kind: 'en_route',
          state: 'skipped',
          sentAt: undefined,
          skippedAt: '2026-01-01T09:00:00Z',
          skipReason: 'superseded',
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    fireEvent.click(await screen.findByText('Earlier reminders (4)'));

    // EXACTLY ONE action in the whole disclosure, and it is the Cancel on the
    // sweep miss - under an accessible name that cannot collide with the
    // current ladder's own "Cancel the Day before reminder".
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName('Cancel the earlier Day before reminder');
    // No Send now anywhere: the server refuses every one of these 409
    // superseded.
    expect(screen.queryByRole('button', { name: /Send the/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument();
  });

  it('gives the earlier Cancel a name distinct from the current ladder rung of the SAME kind', async () => {
    // G4 (research C 2.3): both aria-labels interpolate the kind, so a bare
    // reuse would give two buttons one accessible name - a strict-mode
    // violation for the e2e harness, and an ambiguous target for a navigator
    // driving the panel by voice or keyboard.
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-1', kind: 'day_before', state: 'upcoming' })],
      earlier: [
        earlierRung({
          reminderId: 'e-1',
          kind: 'day_before',
          state: 'upcoming',
          sentAt: undefined,
          suppression: { reason: 'superseded' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    fireEvent.click(await screen.findByText('Earlier reminders (1)'));

    expect(
      screen.getByRole('button', { name: 'Cancel the Day before reminder' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Cancel the earlier Day before reminder' }),
    ).toBeInTheDocument();
  });

  it('Cancel on an earlier rung PATCHes {canceled:true} through the same handler', async () => {
    patchTourReminder.mockResolvedValue({});
    getTourReminders.mockResolvedValue({
      reminders: [],
      earlier: [
        earlierRung({
          reminderId: 'e-miss',
          kind: 'day_before',
          state: 'upcoming',
          sentAt: undefined,
          suppression: { reason: 'superseded' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    fireEvent.click(await screen.findByText('Earlier reminders (1)'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel the earlier Day before reminder' }));
    await waitFor(() =>
      expect(patchTourReminder).toHaveBeenCalledWith('tour-1', 'e-miss', true),
    );
  });

  it('shows the sentBody snapshot, and NO body paragraph at all when there is none', async () => {
    // T7.7 / acceptance 11. The bodyless row must not borrow the current
    // ladder's "Preview unavailable" sentence: nothing failed to compose here,
    // there is simply no snapshot, and offering the failure copy would send a
    // navigator hunting for an outage.
    getTourReminders.mockResolvedValue({
      reminders: [],
      earlier: [
        earlierRung({
          reminderId: 'e-snap',
          kind: 'day_before',
          body: 'Your tour is tomorrow at 10:00 AM.',
        }),
        earlierRung({ reminderId: 'e-bare', kind: 'morning_of' }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    fireEvent.click(await screen.findByText('Earlier reminders (2)'));

    expect(screen.getByText('Your tour is tomorrow at 10:00 AM.')).toBeVisible();
    expect(screen.queryByText(/Preview unavailable/i)).not.toBeInTheDocument();
    // ANTI-VACUITY: the bodyless rung really did render - it is the paragraph
    // that is missing, not the row.
    const bare = screen.getByText('4 hours before').closest('li');
    expect(bare).not.toBeNull();
    expect(bare?.querySelectorAll('p')).toHaveLength(0);
  });

  it('chips a sweep-missed earlier rung "Replaced" and carries its note', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [],
      earlier: [
        earlierRung({
          reminderId: 'e-miss',
          kind: 'day_before',
          state: 'upcoming',
          // Long past due: a fall-through would chip "sending shortly" on a
          // rung nothing will ever claim.
          dueAt: '2000-01-01T00:00:00Z',
          sentAt: undefined,
          suppression: { reason: 'superseded' },
        }),
      ],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    fireEvent.click(await screen.findByText('Earlier reminders (1)'));

    expect(screen.getByText('Replaced')).toBeVisible();
    expect(screen.queryByText(/sending shortly/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Replaced . /)).toBeVisible();
  });

  it('renders no disclosure at all when the server sends no earlier rows', async () => {
    getTourReminders.mockResolvedValue({
      reminders: [rung({ reminderId: 'r-1', kind: 'day_before' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Day before')).toBeInTheDocument());
    expect(screen.queryByText(/Earlier reminders/i)).not.toBeInTheDocument();
  });

  it('a FAILED refetch clears the earlier rows alongside the ladder', async () => {
    // G3 (research C 2.4). `earlier` lives in the same committed state object
    // as `reminders`, and the error branch REPLACES that object. Miss it in
    // either setState and the panel shows an error banner over a stale
    // disclosure - rows from a tour whose ladder it just admitted it cannot
    // read.
    getTourReminders.mockResolvedValueOnce({
      reminders: [],
      earlier: [earlierRung({ reminderId: 'e-1', kind: 'day_before' })],
    } satisfies TourRemindersPage);
    render(<RemindersPanel tourId="tour-1" />);
    await waitFor(() => expect(screen.getByText('Earlier reminders (1)')).toBeInTheDocument());

    getTourReminders.mockRejectedValueOnce(new ApiError(500, 'boom', 'boom'));
    act(() => streamHandlers?.onScheduledUpdated?.({}));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText(/Earlier reminders/i)).not.toBeInTheDocument();
  });
});
